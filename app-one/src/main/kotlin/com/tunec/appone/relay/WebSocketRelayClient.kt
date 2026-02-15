package com.tunec.appone.relay

import android.util.Base64
import android.util.Log
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit

private const val TAG = "WsRelay"

/**
 * WebSocket-based relay client that replaces the in-process [RelayExecutor].
 *
 * Sends [RelayRequest] messages as JSON to AppBack over a persistent WebSocket
 * connection and converts incoming JSON responses back to serialized
 * [RelayResponse] bytes for the VPN service.
 *
 * @param serverUrl  WebSocket URL of AppBack (e.g. `ws://192.168.1.100:3000`)
 * @param protectSocket  VPN protect callback — applied to the OkHttp client's underlying socket
 * @param onResponse  Callback for asynchronous responses (same contract as [RelayExecutor])
 */
class WebSocketRelayClient(
    serverUrl: String,
    protectSocket: (java.net.Socket) -> Boolean,
    onResponse: (ByteArray) -> Unit
) {
    private val onResponse = onResponse

    /** Pending connect futures keyed by connectionId — used to make Connect synchronous. */
    private val pendingConnects = ConcurrentHashMap<String, CompletableFuture<ByteArray>>()

    private val client: OkHttpClient = OkHttpClient.Builder()
        .socketFactory(ProtectedSocketFactory(protectSocket))
        .pingInterval(30, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.SECONDS)  // no timeout on reads — WebSocket is long-lived
        .build()

    private val ws: WebSocket

    init {
        val request = Request.Builder().url(serverUrl).build()
        ws = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                Log.i(TAG, "WebSocket connected to $serverUrl")
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                handleMessage(text)
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                Log.i(TAG, "WebSocket closing: $code $reason")
                webSocket.close(1000, null)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                Log.i(TAG, "WebSocket closed: $code $reason")
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                Log.e(TAG, "WebSocket failure", t)
                // Fail all pending connects
                pendingConnects.values.forEach { future ->
                    future.completeExceptionally(t)
                }
                pendingConnects.clear()
            }
        })
    }

    /**
     * Handle a serialized [RelayRequest].
     *
     * - **Connect**: sends JSON, blocks until "connected"/"error" response arrives.
     *   Returns serialized [RelayResponse.Connected] or [RelayResponse.Error].
     * - **Data** / **Disconnect**: sends JSON, returns `null` immediately.
     */
    fun handleRequest(serialized: ByteArray): ByteArray? {
        val request = RelayRequest.deserialize(serialized)
        return when (request) {
            is RelayRequest.Connect -> {
                val json = JSONObject().apply {
                    put("type", "connect")
                    put("connectionId", request.connectionId)
                    put("destIp", request.destIp)
                    put("destPort", request.destPort)
                }
                val future = CompletableFuture<ByteArray>()
                pendingConnects[request.connectionId] = future
                ws.send(json.toString())
                try {
                    future.get(10, TimeUnit.SECONDS)
                } catch (e: Exception) {
                    pendingConnects.remove(request.connectionId)
                    Log.e(TAG, "Connect timeout/error for ${request.connectionId}", e)
                    RelayResponse.Error(request.connectionId, e.message ?: "timeout").serialize()
                }
            }
            is RelayRequest.Data -> {
                val json = JSONObject().apply {
                    put("type", "data")
                    put("connectionId", request.connectionId)
                    put("payload", Base64.encodeToString(request.payload, Base64.NO_WRAP))
                }
                ws.send(json.toString())
                null
            }
            is RelayRequest.Disconnect -> {
                val json = JSONObject().apply {
                    put("type", "disconnect")
                    put("connectionId", request.connectionId)
                }
                ws.send(json.toString())
                null
            }
        }
    }

    /** Shut down the WebSocket and release resources. */
    fun shutdown() {
        ws.close(1000, "VPN stopping")
        client.dispatcher.executorService.shutdown()
    }

    // ── Internal ────────────────────────────────────────────────────────────

    private fun handleMessage(text: String) {
        try {
            val json = JSONObject(text)
            val type = json.getString("type")
            val connectionId = json.getString("connectionId")

            when (type) {
                "connected" -> {
                    val responseBytes = RelayResponse.Connected(connectionId).serialize()
                    val future = pendingConnects.remove(connectionId)
                    if (future != null) {
                        future.complete(responseBytes)
                    } else {
                        onResponse(responseBytes)
                    }
                }
                "data" -> {
                    val payload = Base64.decode(json.getString("payload"), Base64.NO_WRAP)
                    onResponse(RelayResponse.Data(connectionId, payload).serialize())
                }
                "disconnected" -> {
                    onResponse(RelayResponse.Disconnected(connectionId).serialize())
                    // Also fail any pending connect
                    pendingConnects.remove(connectionId)?.completeExceptionally(
                        Exception("disconnected before connected")
                    )
                }
                "error" -> {
                    val message = json.getString("message")
                    val responseBytes = RelayResponse.Error(connectionId, message).serialize()
                    val future = pendingConnects.remove(connectionId)
                    if (future != null) {
                        future.complete(responseBytes)
                    } else {
                        onResponse(responseBytes)
                    }
                }
                else -> Log.w(TAG, "Unknown message type: $type")
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to parse message: $text", e)
        }
    }

    /**
     * A [javax.net.SocketFactory] that calls [protect] on every socket it creates,
     * so OkHttp traffic bypasses the VPN tunnel.
     */
    private class ProtectedSocketFactory(
        private val protect: (java.net.Socket) -> Boolean
    ) : javax.net.SocketFactory() {
        override fun createSocket(): java.net.Socket {
            return java.net.Socket().also { protect(it) }
        }
        override fun createSocket(host: String, port: Int): java.net.Socket {
            return java.net.Socket(host, port).also { protect(it) }
        }
        override fun createSocket(host: String, port: Int, localAddr: java.net.InetAddress, localPort: Int): java.net.Socket {
            return java.net.Socket(host, port, localAddr, localPort).also { protect(it) }
        }
        override fun createSocket(addr: java.net.InetAddress, port: Int): java.net.Socket {
            return java.net.Socket(addr, port).also { protect(it) }
        }
        override fun createSocket(addr: java.net.InetAddress, port: Int, localAddr: java.net.InetAddress, localPort: Int): java.net.Socket {
            return java.net.Socket(addr, port, localAddr, localPort).also { protect(it) }
        }
    }
}
