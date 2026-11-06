package my.yashh.espbridge;

import android.app.Activity;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.hardware.usb.*;
import android.os.Bundle;
import android.view.WindowManager;
import android.widget.TextView;
import java.io.*;
import java.net.*;

/**
 * Lets a computer reach an ESP32 plugged into this TV's USB port, for boards the computer can't
 * plug into. Speaks RFC 2217 (serial over the network, including the reset lines) on port 5333,
 * so esptool and pyserial can use rfc2217://TV-IP:5333. Handles the CP2102 chip only.
 * It is open to the local network while running, so uninstall it when finished.
 */
public class MainActivity extends Activity {
    static final int PORT = 5333, IAC = 255, SE = 240, SB = 250, WILL = 251, WONT = 252, DO = 253, DONT = 254, COM = 44;
    static final int OUT = 0x41; // vendor request to the interface
    TextView view;
    final StringBuilder lines = new StringBuilder();
    UsbDeviceConnection usb; UsbEndpoint in, out;

    @Override protected void onCreate(Bundle b) {
        super.onCreate(b);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        view = new TextView(this); view.setTextSize(22); view.setPadding(60, 60, 60, 60); setContentView(view);
        Thread t = new Thread(this::run); t.setDaemon(true); t.start();
    }
    void log(String s) {
        android.util.Log.i("EspBridge", s);
        runOnUiThread(() -> { lines.append(s).append('\n'); view.setText("ESP Bridge\n\n" + lines); });
    }
    void run() {
        try {
            UsbManager m = (UsbManager) getSystemService(Context.USB_SERVICE);
            UsbDevice d = null;
            log("Looking for the ESP32 (CP2102)...");
            while (d == null) {
                for (UsbDevice x : m.getDeviceList().values()) if (x.getVendorId() == 0x10c4 && x.getProductId() == 0xea60) d = x;
                if (d == null) Thread.sleep(1000);
            }
            if (!m.hasPermission(d)) {
                log("Press OK on the remote to allow USB access.");
                m.requestPermission(d, PendingIntent.getBroadcast(this, 0, new Intent("my.yashh.espbridge.USB"), PendingIntent.FLAG_MUTABLE));
                while (!m.hasPermission(d)) Thread.sleep(300);
            }
            UsbInterface f = d.getInterface(0);
            usb = m.openDevice(d);
            if (usb == null || !usb.claimInterface(f, true)) { log("Could not open the USB device."); return; }
            for (int i = 0; i < f.getEndpointCount(); i++) {
                UsbEndpoint e = f.getEndpoint(i);
                if (e.getDirection() == UsbConstants.USB_DIR_IN) in = e; else out = e;
            }
            ctl(0x00, 1);       // enable the UART
            ctl(0x03, 0x0800);  // 8 data bits, no parity, 1 stop bit
            baud(115200);
            ServerSocket srv = new ServerSocket(PORT);
            log("Ready on port " + PORT);
            while (true) {
                Socket s = srv.accept(); s.setTcpNoDelay(true);
                log("Computer connected: " + s.getInetAddress().getHostAddress());
                try { serve(s); } catch (IOException e) { }
                try { s.close(); } catch (IOException e) { }
                log("Computer disconnected");
            }
        } catch (Exception e) { log("Stopped: " + e); }
    }
    void ctl(int req, int val) { usb.controlTransfer(OUT, req, val, 0, null, 0, 1000); }
    void baud(int b) {
        byte[] d = { (byte) b, (byte) (b >> 8), (byte) (b >> 16), (byte) (b >> 24) };
        usb.controlTransfer(OUT, 0x1E, 0, 0, d, 4, 1000);
    }
    void serve(Socket s) throws IOException {
        final OutputStream os = new BufferedOutputStream(s.getOutputStream(), 8192);
        final InputStream is = new BufferedInputStream(s.getInputStream(), 8192);
        final boolean[] open = { true };
        Thread up = new Thread(() -> {            // board to computer, doubling any 0xFF
            byte[] b = new byte[512]; byte[] e = new byte[1024];
            try {
                while (open[0]) {
                    int n = usb.bulkTransfer(in, b, b.length, 20);
                    if (n <= 0) continue;
                    int k = 0;
                    for (int i = 0; i < n; i++) { e[k++] = b[i]; if ((b[i] & 255) == IAC) e[k++] = b[i]; }
                    synchronized (os) { os.write(e, 0, k); os.flush(); }
                }
            } catch (IOException x) { open[0] = false; }
        });
        up.setDaemon(true); up.start();
        byte[] w = new byte[4096]; byte[] sb = new byte[64]; int sbn = 0;
        boolean[][] said = new boolean[2][256];
        int st = 0, verb = 0; // 0 data, 1 after IAC, 2 option, 3 inside SB, 4 IAC inside SB
        try {
            while (true) {
                int n = 0, c = is.read();
                if (c < 0) break;
                do {
                    switch (st) {
                        case 0: if (c == IAC) st = 1; else w[n++] = (byte) c; break;
                        case 1:
                            if (c == IAC) { w[n++] = (byte) c; st = 0; }
                            else if (c == SB) { sbn = 0; st = 3; }
                            else if (c >= WILL && c <= DONT) { verb = c; st = 2; }
                            else st = 0;
                            break;
                        case 2: {
                            int side = (verb == DO || verb == DONT) ? 0 : 1;
                            if ((verb == DO || verb == WILL) && !said[side][c]) {
                                said[side][c] = true;
                                send(os, IAC, verb == DO ? WILL : DO, c);
                            }
                            st = 0; break;
                        }
                        case 3: if (c == IAC) st = 4; else if (sbn < sb.length) sb[sbn++] = (byte) c; break;
                        default:
                            if (c == IAC) { if (sbn < sb.length) sb[sbn++] = (byte) c; st = 3; }
                            else { if (c == SE) { flush(w, n); n = 0; command(os, sb, sbn); } st = 0; }
                    }
                    if (n == w.length) { flush(w, n); n = 0; }
                    c = is.available() > 0 && n < w.length ? is.read() : -2;
                } while (c >= 0);
                flush(w, n);
            }
        } finally { open[0] = false; }
    }
    void flush(byte[] w, int n) { int off = 0; while (off < n) {
        int k = usb.bulkTransfer(out, w, off, Math.min(n - off, 64), 1000); if (k <= 0) return; off += k; } }
    void send(OutputStream os, int... v) throws IOException {
        synchronized (os) { for (int x : v) os.write(x); os.flush(); }
    }
    /** A COM-PORT option: act on it, then echo it back with the cmd + 100 the protocol expects. */
    void command(OutputStream os, byte[] sb, int n) throws IOException {
        if (n < 2 || (sb[0] & 255) != COM) return;
        int cmd = sb[1] & 255;
        if (cmd == 1 && n >= 6) {
            int b = (sb[2] & 255) << 24 | (sb[3] & 255) << 16 | (sb[4] & 255) << 8 | (sb[5] & 255);
            if (b > 0) baud(b);
        } else if (cmd == 5 && n >= 3) {
            int v = sb[2] & 255;
            if (v == 8) ctl(0x07, 0x0101); else if (v == 9) ctl(0x07, 0x0100);       // DTR on, off
            else if (v == 11) ctl(0x07, 0x0202); else if (v == 12) ctl(0x07, 0x0200); // RTS on, off
        } else if (cmd == 12) ctl(0x12, 0x000f);                                      // clear buffers
        synchronized (os) {
            os.write(IAC); os.write(SB); os.write(COM); os.write(cmd + 100);
            for (int i = 2; i < n; i++) { os.write(sb[i]); if ((sb[i] & 255) == IAC) os.write(IAC); }
            os.write(IAC); os.write(SE); os.flush();
        }
    }
}
