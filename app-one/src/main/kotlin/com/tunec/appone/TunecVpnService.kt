package com.tunec.appone

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.VpnService
import android.os.Build
import android.os.ParcelFileDescriptor
import android.util.Log
import androidx.core.app.NotificationCompat
import com.tunec.appone.relay.RelayRequest
import com.tunec.appone.relay.RelayResponse
import com.tunec.appone.relay.WebSocketRelayClient
import java.io.FileInputStream
import java.io.FileOutputStream
import java.net.Inet4Address
import java.net.InetAddress
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong
import kotlin.concurrent.thread
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

private const val TAG = "TunecVpn"
private const val CHANNEL_ID = "tunec_vpn"
private const val NOTIFICATION_ID = 1
/** Max TCP payload per segment to stay under typical MTU (1500) = 1500 - 20 IP - 20 TCP */
private const val MAX_TCP_PAYLOAD = 1460
/** WebSocket URL of the AppBack relay server. */
private const val APP_BACK_URL = "ws://192.168.1.93:3000"

enum class VpnStatus { DISCONNECTED, CONNECTING, CONNECTED, ERROR }

class TunecVpnService : VpnService() {

    companion object {
        const val ACTION_DISCONNECT = "com.tunec.appone.DISCONNECT_VPN"
        private val _vpnState = MutableStateFlow(VpnStatus.DISCONNECTED)
        val vpnState: StateFlow<VpnStatus> = _vpnState.asStateFlow()
    }

    private var tunInterface: ParcelFileDescriptor? = null
    private var tunOutput: FileOutputStream? = null
    private var relayThread: Thread? = null
    private var running = false
    private val connections = ConcurrentHashMap<String, ConnectionState>()
    private val tunnelAddress = byteArrayOf(10, 0, 0, 2)
    private var underlyingNetwork: Network? = null
    private var networkCallback: ConnectivityManager.NetworkCallback? = null
    private var ipId = 0
    private var relayClient: WebSocketRelayClient? = null

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_DISCONNECT) {
            disconnect()
            return START_NOT_STICKY
        }
        if (tunInterface != null) return START_STICKY
        _vpnState.value = VpnStatus.CONNECTING
        val iface = establishVpn()
        if (iface == null) {
            Log.e(TAG, "Failed to establish VPN")
            _vpnState.value = VpnStatus.ERROR
            stopSelf()
            return START_NOT_STICKY
        }
        tunInterface = iface
        tunOutput = FileOutputStream(iface.fileDescriptor)
        requestUnderlyingNetwork()
        relayClient = WebSocketRelayClient(
            serverUrl = APP_BACK_URL,
            protectSocket = { socket -> protect(socket) },
            onResponse = { serialized -> handleRelayResponse(serialized) }
        )
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(NOTIFICATION_ID, createNotification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else {
            startForeground(NOTIFICATION_ID, createNotification())
        }
        running = true
        relayThread = thread(name = "TunecRelay") { runRelay(iface) }
        _vpnState.value = VpnStatus.CONNECTED
        return START_STICKY
    }

    private fun disconnect() {
        if (!running && tunInterface == null) return   // already stopped
        Log.i(TAG, "Disconnecting VPN")
        _vpnState.value = VpnStatus.DISCONNECTED
        running = false
        // Close TUN first so the blocking read() in runRelay exits immediately
        tunOutput = null
        try { tunInterface?.close() } catch (_: Exception) {}
        tunInterface = null
        relayThread?.interrupt()
        relayThread = null
        relayClient?.shutdown()
        relayClient = null
        connections.clear()
        networkCallback?.let { cb ->
            try { (getSystemService(CONNECTIVITY_SERVICE) as? ConnectivityManager)?.unregisterNetworkCallback(cb) } catch (_: Exception) {}
        }
        networkCallback = null
        underlyingNetwork = null
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onDestroy() {
        disconnect()
        super.onDestroy()
    }

    // ── VPN setup ──────────────────────────────────────────────────────────

    private fun establishVpn(): ParcelFileDescriptor? {
        return try {
            Builder()
                .addAddress("10.0.0.2", 24)
                .addRoute("0.0.0.0", 0)
                .addAllowedApplication("com.tunec.apptwo")
                .setSession("Tunec VPN")
                .establish()
        } catch (e: Exception) {
            Log.e(TAG, "establish failed", e)
            null
        }
    }

    private fun requestUnderlyingNetwork() {
        val cm = getSystemService(CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return
        val request = NetworkRequest.Builder()
            .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .addCapability(NetworkCapabilities.NET_CAPABILITY_NOT_VPN)
            .build()
        val cb = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                Log.i(TAG, "Underlying network available")
                underlyingNetwork = network
            }
            override fun onLost(network: Network) {
                if (underlyingNetwork == network) underlyingNetwork = null
            }
        }
        networkCallback = cb
        cm.registerNetworkCallback(request, cb)
    }

    // ── Notification ───────────────────────────────────────────────────────

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val ch = NotificationChannel(CHANNEL_ID, "Tunec VPN", NotificationManager.IMPORTANCE_LOW)
            ch.setShowBadge(false)
            getSystemService(NotificationManager::class.java).createNotificationChannel(ch)
        }
    }

    private fun createNotification(): Notification {
        val pi = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Tunec VPN").setContentText("Forwarding App Two traffic")
            .setSmallIcon(android.R.drawable.ic_lock_lock).setContentIntent(pi).setOngoing(true).build()
    }

    // ── Relay loop ─────────────────────────────────────────────────────────

    private fun runRelay(iface: ParcelFileDescriptor) {
        val fd = iface.fileDescriptor
        val input = FileInputStream(fd)
        val output = tunOutput ?: return
        val raw = ByteArray(32767)
        val buf = ByteBuffer.wrap(raw).order(ByteOrder.BIG_ENDIAN)
        Log.i(TAG, "Relay started")
        while (running) {
            try {
                val len = input.read(raw)
                if (len <= 0) continue
                buf.clear(); buf.limit(len)
                processPacket(buf, len, output)
            } catch (e: Exception) {
                if (running) Log.e(TAG, "Relay read error", e)
                break
            }
        }
        Log.i(TAG, "Relay stopped")
    }

    private fun processPacket(buf: ByteBuffer, len: Int, output: FileOutputStream) {
        if (len < 20) return
        val v = buf.get(0).toInt() and 0xFF
        if (v shr 4 != 4) return                      // IPv4 only
        val ihl = (v and 0x0F) * 4
        val proto = buf.get(9).toInt() and 0xFF
        if (proto != 6) return                          // TCP only
        if (len < ihl + 20) return

        val srcIp = ByteArray(4); buf.position(12); buf.get(srcIp)
        val dstIp = ByteArray(4); buf.get(dstIp)
        val srcPort = buf.getShort(ihl).toInt() and 0xFFFF
        val dstPort = buf.getShort(ihl + 2).toInt() and 0xFFFF
        val seq = buf.getInt(ihl + 4)
        val dataOff = ((buf.get(ihl + 12).toInt() and 0xFF) shr 4) * 4
        val flags = buf.get(ihl + 13).toInt() and 0xFF
        val syn = flags and 0x02 != 0
        val ack = flags and 0x10 != 0
        val payloadOff = ihl + dataOff
        val payloadLen = (len - payloadOff).coerceAtLeast(0)

        val dstAddr = InetAddress.getByAddress(dstIp) as? Inet4Address ?: return
        val key = "${formatIp(srcIp)}:$srcPort-${formatIp(dstIp)}:$dstPort"

        // SYN → serialize Connect → executor opens real connection → SYN-ACK to tun
        if (syn && !ack) {
            Log.i(TAG, "OUT  SYN  → ${formatIp(dstIp)}:$dstPort")
            try {
                val request = RelayRequest.Connect(key, formatIp(dstIp), dstPort)
                val respBytes = relayClient?.handleRequest(request.serialize())
                if (respBytes == null) {
                    Log.e(TAG, "No executor or no response for Connect")
                    return
                }
                val resp = RelayResponse.deserialize(respBytes)
                if (resp is RelayResponse.Error) {
                    Log.e(TAG, "Connect error: ${resp.message}")
                    return
                }
                val state = ConnectionState(srcPort, dstAddr, dstPort)
                connections[key] = state
                state.appSeq.set((seq + 1).toLong())
                writeSynAck(state, seq, output)
            } catch (e: Exception) {
                Log.e(TAG, "SYN handling error", e)
            }
            return
        }

        val state = connections[key] ?: return

        // Update expected app seq
        if (payloadLen > 0) state.appSeq.set((seq.toLong() and 0xFFFFFFFFL) + payloadLen)

        // Forward payload via executor
        if (payloadLen > 0) {
            val payload = ByteArray(payloadLen)
            buf.position(payloadOff); buf.get(payload)
            Log.i(TAG, "OUT  DATA → ${formatIp(dstIp)}:$dstPort len=$payloadLen")
            val request = RelayRequest.Data(key, payload)
            relayClient?.handleRequest(request.serialize())
            // ACK to the app so it doesn't retransmit (prevents duplicate data → BAD_RECORD_MAC)
            writeAckOnly(state, output)
        }
    }

    // ── Relay response handler (called from executor reader threads) ───────

    private fun handleRelayResponse(serialized: ByteArray) {
        val response = RelayResponse.deserialize(serialized)
        val out = tunOutput ?: return
        when (response) {
            is RelayResponse.Connected -> { /* handled synchronously in processPacket */ }
            is RelayResponse.Data -> {
                val state = connections[response.connectionId] ?: return
                Log.i(TAG, "IN   DATA ← ${state.serverAddr.hostAddress}:${state.serverPort} len=${response.payload.size}")
                // Send in MTU-sized segments so TLS and IP don't hit fragmentation issues
                var off = 0
                while (off < response.payload.size) {
                    val chunk = (response.payload.size - off).coerceAtMost(MAX_TCP_PAYLOAD)
                    val pkt = buildResponsePacket(state, response.payload, off, chunk)
                    synchronized(out) { out.write(pkt); out.flush() }
                    off += chunk
                }
            }
            is RelayResponse.Disconnected -> {
                connections.remove(response.connectionId)
                Log.i(TAG, "Connection closed: ${response.connectionId}")
            }
            is RelayResponse.Error -> {
                connections.remove(response.connectionId)
                Log.e(TAG, "Relay error ${response.connectionId}: ${response.message}")
            }
        }
    }

    // ── Packet construction ────────────────────────────────────────────────

    private fun writeSynAck(state: ConnectionState, appSeq: Int, out: FileOutputStream) {
        val pkt = ByteArray(40)
        val b = ByteBuffer.wrap(pkt).order(ByteOrder.BIG_ENDIAN)
        writeIpHeader(b, 40, state.serverAddr.address, tunnelAddress)
        // TCP header (20 bytes)
        b.putShort((state.serverPort and 0xFFFF).toShort()) // src port
        b.putShort((state.clientPort and 0xFFFF).toShort()) // dst port
        b.putInt(1)                                          // seq = 1  (ISN)
        b.putInt(appSeq + 1)                                 // ack = client ISN + 1
        b.put(0x50.toByte())                                 // data offset = 5 words
        b.put(0x12.toByte())                                 // flags = SYN+ACK
        b.putShort(65535.toShort())                           // window
        b.putShort(0)                                         // checksum (filled below)
        b.putShort(0)                                         // urgent ptr
        computeChecksums(pkt, 20, 20, 0)
        synchronized(out) { out.write(pkt); out.flush() }
    }

    /** Send ACK-only segment to the app so it doesn't retransmit (avoids duplicate TLS data). */
    private fun writeAckOnly(state: ConnectionState, out: FileOutputStream) {
        val pkt = ByteArray(40)
        val b = ByteBuffer.wrap(pkt).order(ByteOrder.BIG_ENDIAN)
        writeIpHeader(b, 40, state.serverAddr.address, tunnelAddress)
        b.putShort((state.serverPort and 0xFFFF).toShort())
        b.putShort((state.clientPort and 0xFFFF).toShort())
        b.putInt(state.ourSeq.get().toInt())                 // our seq (no new data)
        b.putInt(state.appSeq.get().toInt())                 // ack = next expected from app
        b.put(0x50.toByte())                                 // data offset = 5
        b.put(0x10.toByte())                                 // flags = ACK only
        b.putShort(65535.toShort())                           // window
        b.putShort(0)
        b.putShort(0)
        computeChecksums(pkt, 20, 20, 0)
        synchronized(out) { out.write(pkt); out.flush() }
    }

    private fun buildResponsePacket(state: ConnectionState, payload: ByteArray, offset: Int, payloadLen: Int): ByteArray {
        val totalLen = 40 + payloadLen
        val pkt = ByteArray(totalLen)
        val b = ByteBuffer.wrap(pkt).order(ByteOrder.BIG_ENDIAN)
        writeIpHeader(b, totalLen, state.serverAddr.address, tunnelAddress)
        // TCP header
        b.putShort((state.serverPort and 0xFFFF).toShort())
        b.putShort((state.clientPort and 0xFFFF).toShort())
        b.putInt(state.ourSeq.get().toInt())
        b.putInt(state.appSeq.get().toInt())
        b.put(0x50.toByte())                                 // data offset = 5
        b.put(0x18.toByte())                                 // flags = PSH+ACK
        b.putShort(65535.toShort())                           // window
        b.putShort(0)                                         // checksum
        b.putShort(0)                                         // urgent ptr
        b.put(payload, offset, payloadLen)
        state.ourSeq.addAndGet(payloadLen.toLong())
        computeChecksums(pkt, 20, 20, payloadLen)
        return pkt
    }

    /**
     * Writes a correct 20-byte IPv4 header at the current position (0).
     */
    private fun writeIpHeader(b: ByteBuffer, totalLen: Int, srcIp: ByteArray, dstIp: ByteArray) {
        b.put(0x45.toByte())                                 //  0: ver=4 ihl=5
        b.put(0.toByte())                                    //  1: DSCP/ECN
        b.putShort(totalLen.toShort())                        //  2-3: total length
        b.putShort((++ipId and 0xFFFF).toShort())             //  4-5: identification
        b.putShort(0x4000.toShort())                          //  6-7: flags=DF, frag offset=0
        b.put(64.toByte())                                    //  8: TTL
        b.put(6.toByte())                                     //  9: protocol=TCP
        b.putShort(0.toShort())                               // 10-11: checksum (filled later)
        b.put(srcIp)                                          // 12-15: source IP
        b.put(dstIp)                                          // 16-19: dest IP
    }

    /**
     * Compute and fill IP header checksum (offset 10) and TCP checksum (offset ipLen+16).
     */
    private fun computeChecksums(pkt: ByteArray, ipLen: Int, tcpLen: Int, payloadLen: Int) {
        val b = ByteBuffer.wrap(pkt).order(ByteOrder.BIG_ENDIAN)

        // IP checksum
        b.putShort(10, 0)
        var ipSum = 0L
        for (i in 0 until ipLen step 2) {
            ipSum += (pkt[i].toInt() and 0xFF shl 8) or (pkt[i + 1].toInt() and 0xFF)
        }
        while (ipSum shr 16 != 0L) ipSum = (ipSum and 0xFFFF) + (ipSum shr 16)
        b.putShort(10, (ipSum.inv() and 0xFFFF).toShort())

        // TCP checksum (over pseudo-header + tcp segment)
        val tcpOff = ipLen
        b.putShort(tcpOff + 16, 0)
        val segLen = tcpLen + payloadLen
        var tcpSum = 0L
        // pseudo-header: src IP + dst IP + 0 + proto + tcp length
        for (i in 12..18 step 2) {
            tcpSum += (pkt[i].toInt() and 0xFF shl 8) or (pkt[i + 1].toInt() and 0xFF)
        }
        tcpSum += 6L            // protocol TCP
        tcpSum += segLen.toLong()
        // tcp segment
        var i = tcpOff
        while (i < tcpOff + segLen - 1) {
            tcpSum += (pkt[i].toInt() and 0xFF shl 8) or (pkt[i + 1].toInt() and 0xFF)
            i += 2
        }
        if (i < tcpOff + segLen) tcpSum += (pkt[i].toInt() and 0xFF) shl 8  // odd byte
        while (tcpSum shr 16 != 0L) tcpSum = (tcpSum and 0xFFFF) + (tcpSum shr 16)
        b.putShort(tcpOff + 16, (tcpSum.inv() and 0xFFFF).toShort())
    }

    private fun formatIp(ip: ByteArray) =
        "${ip[0].toInt() and 0xFF}.${ip[1].toInt() and 0xFF}.${ip[2].toInt() and 0xFF}.${ip[3].toInt() and 0xFF}"

    /** TCP connection state — tracks seq/ack numbers and port info for packet construction. */
    private class ConnectionState(
        val clientPort: Int,
        val serverAddr: Inet4Address,
        val serverPort: Int
    ) {
        val appSeq = AtomicLong(0)
        val ourSeq = AtomicLong(2)  // SYN-ACK ISN=1 consumes 1 seq, so first data byte = 2
    }
}
