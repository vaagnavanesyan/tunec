package com.tunec.appone.relay

import android.util.Log
import java.net.InetSocketAddress
import java.net.Socket
import java.util.concurrent.ConcurrentHashMap
import kotlin.concurrent.thread

private const val TAG = "RelayExec"

/**
 * Executes relay requests by managing real TCP connections to destination servers.
 *
 * Accepts serialized [RelayRequest] bytes, deserializes them, and performs the
 * corresponding network operations. Server responses arrive asynchronously via
 * the [onResponse] callback.
 *
 * @param protectSocket  Called before connect(); must return true to proceed (VPN protect).
 * @param bindSocket     Binds socket to the underlying (non-VPN) network.
 * @param onResponse     Callback for asynchronous responses (server data, disconnects, errors).
 *                        Invoked on reader threads — callers must synchronize if needed.
 */
class RelayExecutor(
    private val protectSocket: (Socket) -> Boolean,
    private val bindSocket: (Socket) -> Unit,
    private val onResponse: (ByteArray) -> Unit
) {
    private val connections = ConcurrentHashMap<String, Socket>()
    @Volatile
    var running = true

    /**
     * Handle a serialized [RelayRequest].
     *
     * - **Connect**: blocks until the TCP connection is established (or fails).
     *   Returns a serialized [RelayResponse.Connected] or [RelayResponse.Error].
     * - **Data**: writes payload to the existing socket. Returns `null`.
     * - **Disconnect**: closes the socket. Returns `null`.
     */
    fun handleRequest(serialized: ByteArray): ByteArray? {
        Log.d(TAG, "handleRequest: ${serialized.joinToString("") { "%02x ".format(it) }}")
        val request = RelayRequest.deserialize(serialized)
        return when (request) {
            is RelayRequest.Connect -> handleConnect(request)
            is RelayRequest.Data -> { handleData(request); null }
            is RelayRequest.Disconnect -> { handleDisconnect(request); null }
            is RelayRequest.ShutdownWrite -> { handleShutdownWrite(request); null }
        }
    }

    /** Close all managed connections and stop reader threads. */
    fun shutdown() {
        running = false
        connections.values.forEach { try { it.close() } catch (_: Exception) {} }
        connections.clear()
    }

    // ── Internal handlers ──────────────────────────────────────────────────

    private fun handleConnect(req: RelayRequest.Connect): ByteArray {
        return try {
            val socket = Socket()
            socket.bind(null)                                      // allocates fd
            if (!protectSocket(socket)) {
                socket.close()
                throw IllegalStateException("protect failed")
            }
            bindSocket(socket)
            socket.connect(InetSocketAddress(req.destIp, req.destPort), 10_000)
            socket.soTimeout = 0
            socket.tcpNoDelay = true
            connections[req.connectionId] = socket
            Log.i(TAG, "Connected ${req.connectionId} → ${req.destIp}:${req.destPort}")
            startReader(req.connectionId, socket)
            RelayResponse.Connected(req.connectionId).serialize()
        } catch (e: Exception) {
            Log.e(TAG, "Connect failed ${req.connectionId}", e)
            RelayResponse.Error(req.connectionId, e.message ?: e.javaClass.simpleName).serialize()
        }
    }

    private fun handleData(req: RelayRequest.Data) {
        val socket = connections[req.connectionId]
        if (socket == null) {
            Log.w(TAG, "Data for unknown connection ${req.connectionId}")
            onResponse(RelayResponse.Error(req.connectionId, "unknown connection").serialize())
            return
        }
        try {
            socket.getOutputStream().write(req.payload)
            socket.getOutputStream().flush()
        } catch (e: Exception) {
            Log.e(TAG, "Write error ${req.connectionId}", e)
            connections.remove(req.connectionId)
            try { socket.close() } catch (_: Exception) {}
            onResponse(RelayResponse.Disconnected(req.connectionId).serialize())
        }
    }

    private fun handleDisconnect(req: RelayRequest.Disconnect) {
        val socket = connections.remove(req.connectionId)
        if (socket != null) {
            try { socket.close() } catch (_: Exception) {}
            Log.i(TAG, "Disconnected ${req.connectionId}")
        }
    }

    private fun handleShutdownWrite(req: RelayRequest.ShutdownWrite) {
        val socket = connections[req.connectionId]
        if (socket != null) {
            try {
                socket.shutdownOutput()
                Log.i(TAG, "Shutdown write ${req.connectionId}")
            } catch (_: Exception) {}
        }
    }

    private fun startReader(connectionId: String, socket: Socket) {
        thread(name = "RelayReader-$connectionId") {
            try {
                val inp = socket.getInputStream()
                val buf = ByteArray(16384)
                while (running && !socket.isClosed) {
                    val n = inp.read(buf)
                    if (n <= 0) break
                    Log.i(TAG, "IN DATA ← $connectionId len=$n")
                    val payload = buf.copyOf(n)
                    onResponse(RelayResponse.Data(connectionId, payload).serialize())
                }
            } catch (e: Exception) {
                if (running) Log.e(TAG, "Reader error $connectionId", e)
            } finally {
                connections.remove(connectionId)
                try { socket.close() } catch (_: Exception) {}
                onResponse(RelayResponse.Disconnected(connectionId).serialize())
            }
        }
    }
}
