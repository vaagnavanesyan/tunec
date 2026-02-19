package com.tunec.appone.relay

import android.util.Log
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit

private const val TAG = "WsRelay"

/**
 * WebSocket-based relay client that replaces the in-process [RelayExecutor].
 *
 * Sends [RelayRequest] messages as binary (format from RelayMessage.kt) to AppBack and
 * receives binary [RelayResponse] frames, passing them through to the VPN service.
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

            override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                handleMessage(bytes.toByteArray())
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
     * - **Connect**: sends binary, blocks until "connected"/"error" response arrives.
     *   Returns serialized [RelayResponse.Connected] or [RelayResponse.Error].
     * - **Data** / **Disconnect**: sends binary, returns `null` immediately.
     */
    fun handleRequest(serialized: ByteArray): ByteArray? {
        val request = RelayRequest.deserialize(serialized)
        return when (request) {
            is RelayRequest.Connect -> {
                val future = CompletableFuture<ByteArray>()
                pendingConnects[request.connectionId] = future
                ws.send(ByteString.of(*serialized))
                try {
                    future.get(10, TimeUnit.SECONDS)
                } catch (e: Exception) {
                    pendingConnects.remove(request.connectionId)
                    Log.e(TAG, "Connect timeout/error for ${request.connectionId}", e)
                    RelayResponse.Error(request.connectionId, e.message ?: "timeout").serialize()
                }
            }
            is RelayRequest.Data -> {
                ws.send(ByteString.of(*serialized))
                null
            }
            is RelayRequest.Disconnect -> {
                ws.send(ByteString.of(*serialized))
                null
            }
            is RelayRequest.ShutdownWrite -> {
                ws.send(ByteString.of(*serialized))
                null
            }
        }
    }

    /** Tell AppBack to half-close the socket (client finished sending; server can still respond). */
    fun sendShutdownWrite(connectionId: String) {
        val bytes = RelayRequest.ShutdownWrite(connectionId).serialize()
        ws.send(ByteString.of(*bytes))
    }

    /** Shut down the WebSocket and release resources. */
    fun shutdown() {
        ws.close(1000, "VPN stopping")
        client.dispatcher.executorService.shutdown()
    }

    // ── Internal ────────────────────────────────────────────────────────────

    private fun handleMessage(bytes: ByteArray) {
        try {
            val response = RelayResponse.deserialize(bytes)
            when (response) {
                is RelayResponse.Connected -> {
                    val future = pendingConnects.remove(response.connectionId)
                    if (future != null) {
                        future.complete(bytes)
                    } else {
                        onResponse(bytes)
                    }
                }
                is RelayResponse.Data -> onResponse(bytes)
                is RelayResponse.Disconnected -> {
                    onResponse(bytes)
                    pendingConnects.remove(response.connectionId)?.completeExceptionally(
                        Exception("disconnected before connected")
                    )
                }
                is RelayResponse.Error -> {
                    val future = pendingConnects.remove(response.connectionId)
                    if (future != null) {
                        future.complete(bytes)
                    } else {
                        onResponse(bytes)
                    }
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to parse binary message", e)
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
