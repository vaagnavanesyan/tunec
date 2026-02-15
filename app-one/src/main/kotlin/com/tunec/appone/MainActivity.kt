package com.tunec.appone

import android.content.Intent
import android.net.VpnService
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import com.tunec.appone.ui.theme.AppOneTheme
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

class MainActivity : ComponentActivity() {

    private val vpnPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        if (result.resultCode == RESULT_OK) {
            startVpnService()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            AppOneTheme {
                Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                    AppOneScreen(
                        vpnState = TunecVpnService.vpnState,
                        onConnectVpn = { tryConnectVpn() },
                        onDisconnectVpn = { stopVpnService() }
                    )
                }
            }
        }
    }

    private fun tryConnectVpn() {
        val intent = VpnService.prepare(this)
        if (intent != null) {
            vpnPermissionLauncher.launch(intent)
        } else {
            startVpnService()
        }
    }

    private fun startVpnService() {
        startService(Intent(this, TunecVpnService::class.java))
    }

    private fun stopVpnService() {
        stopService(Intent(this, TunecVpnService::class.java))
    }
}

@Composable
fun AppOneScreen(
    vpnState: StateFlow<VpnStatus> = MutableStateFlow(VpnStatus.DISCONNECTED),
    onConnectVpn: () -> Unit = {},
    onDisconnectVpn: () -> Unit = {}
) {
    val status by vpnState.collectAsState()

    Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(16.dp),
            modifier = Modifier.padding(24.dp)
        ) {
            Text("App One", style = MaterialTheme.typography.headlineMedium)

            when (status) {
                VpnStatus.DISCONNECTED, VpnStatus.ERROR -> {
                    Button(onClick = onConnectVpn) {
                        Text("Connect to VPN")
                    }
                }
                VpnStatus.CONNECTING -> {
                    Button(onClick = {}, enabled = false) {
                        Text("Connecting...")
                    }
                }
                VpnStatus.CONNECTED -> {
                    Button(
                        onClick = onDisconnectVpn,
                        colors = ButtonDefaults.buttonColors(
                            containerColor = MaterialTheme.colorScheme.error
                        )
                    ) {
                        Text("Disconnect VPN")
                    }
                }
            }

            Text(
                text = when (status) {
                    VpnStatus.DISCONNECTED -> "Disconnected"
                    VpnStatus.CONNECTING -> "Connecting..."
                    VpnStatus.CONNECTED -> "Connected"
                    VpnStatus.ERROR -> "Connection error"
                },
                style = MaterialTheme.typography.titleMedium,
                color = when (status) {
                    VpnStatus.CONNECTED -> MaterialTheme.colorScheme.primary
                    VpnStatus.ERROR -> MaterialTheme.colorScheme.error
                    else -> MaterialTheme.colorScheme.onSurfaceVariant
                }
            )
        }
    }
}

@Preview(showBackground = true)
@Composable
fun AppOneScreenPreview() {
    AppOneTheme {
        AppOneScreen()
    }
}
