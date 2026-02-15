package com.tunec.apptwo

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import com.tunec.apptwo.ui.theme.AppTwoTheme
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import java.security.cert.X509Certificate
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager

private const val REQUEST_URL = "https://192.168.1.101:8080/index.html"

/**
 * Создаёт OkHttpClient, доверяющий самоподписанным сертификатам.
 * Использовать только для разработки/внутренних серверов.
 */
private fun createOkHttpClientForSelfSignedServer(): OkHttpClient {
    val trustAllCerts = arrayOf<TrustManager>(
        object : X509TrustManager {
            override fun checkClientTrusted(chain: Array<out X509Certificate>, authType: String) {}
            override fun checkServerTrusted(chain: Array<out X509Certificate>, authType: String) {}
            override fun getAcceptedIssuers(): Array<X509Certificate> = arrayOf()
        }
    )
    val sslContext = SSLContext.getInstance("TLS")
    sslContext.init(null, trustAllCerts, java.security.SecureRandom())
    return OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(10, TimeUnit.SECONDS)
        .sslSocketFactory(sslContext.socketFactory, trustAllCerts[0] as X509TrustManager)
        .hostnameVerifier { _, _ -> true }
        .build()
}

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            AppTwoTheme {
                Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                    AppTwoScreen()
                }
            }
        }
    }
}

@Composable
fun AppTwoScreen() {
    var resultText by remember { mutableStateOf<String?>(null) }
    var isError by remember { mutableStateOf(false) }
    var loading by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(16.dp),
            modifier = Modifier.padding(24.dp)
        ) {
            Text("App Two", style = MaterialTheme.typography.headlineMedium)
            Button(
                onClick = {
                    loading = true
                    resultText = null
                    scope.launch {
                        try {
                            val code = withContext(Dispatchers.IO) {
                                val client = createOkHttpClientForSelfSignedServer()
                                val request = Request.Builder().url(REQUEST_URL).build()
                                client.newCall(request).execute().code
                            }
                            withContext(Dispatchers.Main.immediate) {
                                resultText = "Код ответа: $code"
                                isError = false
                            }
                        } catch (e: Exception) {
                            withContext(Dispatchers.Main.immediate) {
                                resultText = "Ошибка: ${e.message ?: e.javaClass.simpleName}"
                                isError = true
                            }
                        } finally {
                            withContext(Dispatchers.Main.immediate) {
                                loading = false
                            }
                        }
                    }
                },
                enabled = !loading
            ) {
                Text(if (loading) "Запрос…" else "Запросить")
            }
            resultText?.let { text ->
                Text(
                    text = text,
                    style = MaterialTheme.typography.titleMedium,
                    color = if (isError) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface
                )
            }
        }
    }
}

@Preview(showBackground = true)
@Composable
fun AppTwoScreenPreview() {
    AppTwoTheme {
        AppTwoScreen()
    }
}
