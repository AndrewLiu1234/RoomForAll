# Runtime Observation, Network Tracing & Replay

When static analysis is hindered by heavy packing, obfuscation, or dynamic evaluation, dynamic runtime observation captures ground-truth behavior during execution.

---

## 1. Network Traffic Analysis (.HAR, Proxies, Packet Captures)

### Inspecting HTTP Archive (.HAR) Files
HAR files capture all HTTP/HTTPS interactions, headers, cookies, and responses recorded by Chrome DevTools or proxy tools:
```bash
# Extract API endpoints from a HAR file using jq
cat session.har | jq '.log.entries[] | { method: .request.method, url: .request.url, status: .response.status }'

# Search for specific authorization headers or token returns
cat session.har | jq '.log.entries[] | select(.request.headers[].name | test("authorization"; "i")) | .request.url'
```

### Capturing with Mitmproxy
Mitmproxy acts as an intercepting proxy for live applications:
```bash
# Launch interactive mitmproxy listening on port 8080
mitmproxy -p 8080

# Or run non-interactive flow dump to a file
mitmdump -p 8080 -w traffic.mitm
```

### Parsing PCAP / Network Packets
For non-HTTP binary protocols (WebSocket, gRPC, raw TCP/UDP):
```bash
# Extract TLS SNI headers from pcap
tshark -r capture.pcap -Y 'ssl.handshake.extensions_server_name' -T fields -e ssl.handshake.extensions_server_name | sort -u

# Follow TCP stream in Wireshark/tshark
tshark -r capture.pcap -z follow,tcp,ascii,0
```

---

## 2. Browser & Chrome DevTools Protocol (CDP)

For web targets and single-page applications, CDP allows programmatically interacting with and tracing JavaScript execution.

### Key CDP Domains
- **`Network`**: Enable network event listening, intercept requests (`Network.setRequestInterception`), mock responses.
- **`Page` / `DOM`**: Inspect rendered DOM trees, iframe structures, shadow DOM.
- **`Runtime`**: Evaluate expressions in page context (`Runtime.evaluate`), inspect global variables and window objects.
- **`Debugger`**: Set breakpoints on XHR/fetch (`Debugger.setXHRBreakpoint`), trace call stacks.

### Headless Tracing via Puppeteer / Playwright
```javascript
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  // Listen to all network requests
  page.on('request', request => {
    console.log(`>> [${request.method()}] ${request.url()}`);
    if (request.postData()) {
      console.log(`   Payload: ${request.postData()}`);
    }
  });

  page.on('response', async response => {
    if (response.url().includes('/api/')) {
      console.log(`<< Status: ${response.status()}`);
      try {
        const body = await response.json();
        console.log(`   Response:`, body);
      } catch (e) {}
    }
  });

  await page.goto('https://target-app.example.com');
  await browser.close();
})();
```

---

## 3. Dynamic Instrumentation (Frida)

When analyzing native apps or Android APKs with TLS pinning or root detection:
- Frida injects a JavaScript engine into the target process to hook functions at runtime.
```javascript
// Example: Bypass Android SSL pinning
Java.perform(function () {
  var CertificatePinner = Java.use("okhttp3.CertificatePinner");
  CertificatePinner.check.overload('java.lang.String', 'java.util.List').implementation = function (hostname, peerCertificates) {
    console.log("[+] Bypassed CertificatePinner for " + hostname);
    return;
  };
});
```
```bash
# Attach to running process
frida -U -f com.example.app -l bypass_pinning.js --no-pause
```

