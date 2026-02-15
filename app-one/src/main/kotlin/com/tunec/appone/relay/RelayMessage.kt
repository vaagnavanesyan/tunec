package com.tunec.appone.relay

import java.nio.ByteBuffer
import java.nio.ByteOrder

// ── Request: VPN → Executor ────────────────────────────────────────────────

sealed class RelayRequest {
    abstract val connectionId: String

    data class Connect(
        override val connectionId: String,
        val destIp: String,
        val destPort: Int
    ) : RelayRequest()

    data class Data(
        override val connectionId: String,
        val payload: ByteArray
    ) : RelayRequest() {
        override fun equals(other: Any?): Boolean {
            if (this === other) return true
            if (other !is Data) return false
            return connectionId == other.connectionId && payload.contentEquals(other.payload)
        }
        override fun hashCode(): Int = 31 * connectionId.hashCode() + payload.contentHashCode()
    }

    data class Disconnect(
        override val connectionId: String
    ) : RelayRequest()

    fun serialize(): ByteArray {
        return when (this) {
            is Connect -> {
                val idBytes = connectionId.toByteArray(Charsets.UTF_8)
                val ipBytes = destIp.toByteArray(Charsets.UTF_8)
                ByteBuffer.allocate(1 + 2 + idBytes.size + 2 + ipBytes.size + 2)
                    .order(ByteOrder.BIG_ENDIAN)
                    .put(TYPE_CONNECT)
                    .putShort(idBytes.size.toShort()).put(idBytes)
                    .putShort(ipBytes.size.toShort()).put(ipBytes)
                    .putShort(destPort.toShort())
                    .array()
            }
            is Data -> {
                val idBytes = connectionId.toByteArray(Charsets.UTF_8)
                ByteBuffer.allocate(1 + 2 + idBytes.size + 4 + payload.size)
                    .order(ByteOrder.BIG_ENDIAN)
                    .put(TYPE_DATA)
                    .putShort(idBytes.size.toShort()).put(idBytes)
                    .putInt(payload.size).put(payload)
                    .array()
            }
            is Disconnect -> {
                val idBytes = connectionId.toByteArray(Charsets.UTF_8)
                ByteBuffer.allocate(1 + 2 + idBytes.size)
                    .order(ByteOrder.BIG_ENDIAN)
                    .put(TYPE_DISCONNECT)
                    .putShort(idBytes.size.toShort()).put(idBytes)
                    .array()
            }
        }
    }

    companion object {
        private const val TYPE_CONNECT: Byte = 0x01
        private const val TYPE_DATA: Byte = 0x02
        private const val TYPE_DISCONNECT: Byte = 0x03

        fun deserialize(bytes: ByteArray): RelayRequest {
            val buf = ByteBuffer.wrap(bytes).order(ByteOrder.BIG_ENDIAN)
            return when (buf.get()) {
                TYPE_CONNECT -> {
                    val id = readString(buf)
                    val ip = readString(buf)
                    val port = buf.getShort().toInt() and 0xFFFF
                    Connect(id, ip, port)
                }
                TYPE_DATA -> {
                    val id = readString(buf)
                    val payload = readBytes(buf)
                    Data(id, payload)
                }
                TYPE_DISCONNECT -> {
                    val id = readString(buf)
                    Disconnect(id)
                }
                else -> throw IllegalArgumentException("Unknown RelayRequest type")
            }
        }
    }
}

// ── Response: Executor → VPN ───────────────────────────────────────────────

sealed class RelayResponse {
    abstract val connectionId: String

    data class Connected(override val connectionId: String) : RelayResponse()

    data class Data(
        override val connectionId: String,
        val payload: ByteArray
    ) : RelayResponse() {
        override fun equals(other: Any?): Boolean {
            if (this === other) return true
            if (other !is Data) return false
            return connectionId == other.connectionId && payload.contentEquals(other.payload)
        }
        override fun hashCode(): Int = 31 * connectionId.hashCode() + payload.contentHashCode()
    }

    data class Disconnected(override val connectionId: String) : RelayResponse()

    data class Error(
        override val connectionId: String,
        val message: String
    ) : RelayResponse()

    fun serialize(): ByteArray {
        return when (this) {
            is Connected -> {
                val idBytes = connectionId.toByteArray(Charsets.UTF_8)
                ByteBuffer.allocate(1 + 2 + idBytes.size)
                    .order(ByteOrder.BIG_ENDIAN)
                    .put(TYPE_CONNECTED)
                    .putShort(idBytes.size.toShort()).put(idBytes)
                    .array()
            }
            is Data -> {
                val idBytes = connectionId.toByteArray(Charsets.UTF_8)
                ByteBuffer.allocate(1 + 2 + idBytes.size + 4 + payload.size)
                    .order(ByteOrder.BIG_ENDIAN)
                    .put(TYPE_DATA)
                    .putShort(idBytes.size.toShort()).put(idBytes)
                    .putInt(payload.size).put(payload)
                    .array()
            }
            is Disconnected -> {
                val idBytes = connectionId.toByteArray(Charsets.UTF_8)
                ByteBuffer.allocate(1 + 2 + idBytes.size)
                    .order(ByteOrder.BIG_ENDIAN)
                    .put(TYPE_DISCONNECTED)
                    .putShort(idBytes.size.toShort()).put(idBytes)
                    .array()
            }
            is Error -> {
                val idBytes = connectionId.toByteArray(Charsets.UTF_8)
                val msgBytes = message.toByteArray(Charsets.UTF_8)
                ByteBuffer.allocate(1 + 2 + idBytes.size + 2 + msgBytes.size)
                    .order(ByteOrder.BIG_ENDIAN)
                    .put(TYPE_ERROR)
                    .putShort(idBytes.size.toShort()).put(idBytes)
                    .putShort(msgBytes.size.toShort()).put(msgBytes)
                    .array()
            }
        }
    }

    companion object {
        private const val TYPE_CONNECTED: Byte = 0x01
        private const val TYPE_DATA: Byte = 0x02
        private const val TYPE_DISCONNECTED: Byte = 0x03
        private const val TYPE_ERROR: Byte = 0x04

        fun deserialize(bytes: ByteArray): RelayResponse {
            val buf = ByteBuffer.wrap(bytes).order(ByteOrder.BIG_ENDIAN)
            return when (buf.get()) {
                TYPE_CONNECTED -> Connected(readString(buf))
                TYPE_DATA -> {
                    val id = readString(buf)
                    val payload = readBytes(buf)
                    Data(id, payload)
                }
                TYPE_DISCONNECTED -> Disconnected(readString(buf))
                TYPE_ERROR -> {
                    val id = readString(buf)
                    val msg = readString(buf)
                    Error(id, msg)
                }
                else -> throw IllegalArgumentException("Unknown RelayResponse type")
            }
        }
    }
}

// ── Shared helpers ─────────────────────────────────────────────────────────

private fun readString(buf: ByteBuffer): String {
    val len = buf.getShort().toInt() and 0xFFFF
    val bytes = ByteArray(len)
    buf.get(bytes)
    return String(bytes, Charsets.UTF_8)
}

private fun readBytes(buf: ByteBuffer): ByteArray {
    val len = buf.getInt()
    val bytes = ByteArray(len)
    buf.get(bytes)
    return bytes
}
