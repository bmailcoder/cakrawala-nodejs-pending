const express = require("express");
const axios = require("axios");
const fs = require("fs");
const WebSocket = require("ws");

const app = express();
const PORT = 3000;
const COOKIE_FILE = "cookies.json";
const BASE_URL = "https://cakrawala.id.panasonic.com/partner-api/work-orders";

let currentHeaders = null;

function loadCookies() {
    try {
        if (!fs.existsSync(COOKIE_FILE)) return null;
        const rawCookies = JSON.parse(fs.readFileSync(COOKIE_FILE));
        const allowedCookies = ["laravel_session", "XSRF-TOKEN", "token_partner"];
        const cookies = rawCookies.filter(c => allowedCookies.includes(c.name));
        const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join("; ");
        const xsrf = cookies.find(c => c.name === "XSRF-TOKEN")?.value;

        return {
            Cookie: cookieHeader,
            "X-XSRF-TOKEN": decodeURIComponent(xsrf || ""),
            "Accept": "application/json",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0"
        };
    } catch (e) {
        console.error("Gagal load cookies:", e.message);
        return null;
    }
}

currentHeaders = loadCookies();

// Watcher untuk update cookies otomatis
fs.watch(COOKIE_FILE, (eventType) => {
    if (eventType === "change") {
        console.log("File cookies.json berubah, mengupdate session...");
        currentHeaders = loadCookies();
        broadcast();
    }
});

async function fetchAll() {
    if (!currentHeaders) return { error: "MISSING_COOKIE", items: [] };
    let all = [];
    for (let i = 1; i <= 5; i++) {
        try {
            const res = await axios.get(`${BASE_URL}?page=${i}&count=100`, { headers: currentHeaders, timeout: 10000 });
            const items = res.data.result?.items || [];
            if (!items.length) break;
            all = all.concat(items);
        } catch (e) {
            if (e.response?.status === 401 || e.response?.status === 419) return { error: "AUTH_EXPIRED", items: [] };
            break;
        }
    }
    return { error: null, items: all };
}

app.get("/", (req, res) => {
    res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>Dashboard WO Realtime</title>
    <script src="https://cdn.sheetjs.com/xlsx-0.20.1/package/dist/xlsx.full.min.js"></script>
    <style>
        body { font-family: 'Segoe UI', sans-serif; background:#111; color:#eee; margin: 20px; }
        .summary { margin-bottom: 20px; display: flex; gap: 10px; flex-wrap: wrap; }
        .badge { padding:8px 16px; border-radius:8px; font-weight: bold; }
        .new { background:#2ecc71; } .progress { background:#3498db; } .unpaid { background:#e67e22; }
        .auth-error { background: #c0392b; padding: 15px; border-radius: 8px; margin-bottom: 20px; display: none; }
        .controls { background: #1a1a1a; padding: 15px; border-radius: 8px; border: 1px solid #333; margin-bottom: 20px; }
        .filter-group { display: flex; gap: 15px; flex-wrap: wrap; align-items: center; margin-top: 10px; font-size: 14px; }
        .filter-group label { cursor: pointer; display: flex; align-items: center; gap: 5px; }
        input#search { padding:10px; background:#222; color:#eee; border:1px solid #444; width: 100%; max-width: 400px; border-radius: 4px; }
        .btn-export { background: #27ae60; color: white; border: none; padding: 10px 20px; border-radius: 4px; cursor: pointer; font-weight: bold; float: right; }
        .table-container { background: #1a1a1a; border-radius: 8px; overflow-x: auto; margin-top: 10px; }
        table { width:100%; border-collapse:collapse; min-width: 900px; }
        th, td { padding:12px; text-align: left; border-bottom:1px solid #222; }
        tr.row-new { background: rgba(46, 204, 113, 0.1); }
        tr.row-progress { background: rgba(52, 152, 219, 0.1); }
        tr.row-unpaid { background: rgba(230, 126, 34, 0.15); }
        #status-ws { float: right; font-size: 12px; color: #888; }
        a { color:#4da6ff; text-decoration:none; font-weight: bold; }
    </style>
</head>
<body>
    <div id="status-ws">Connecting...</div>
    <h1>Dashboard WO Realtime</h1>

    <div id="auth-alert" class="auth-error">
        <strong>⚠️ SESI BERAKHIR:</strong> Cookies expired. Upload cookies.json baru untuk melanjutkan.
    </div>

    <div class="summary" id="summary"></div>

    <div class="controls">
        <button class="btn-export" onclick="exportToExcel()">📊 Export Excel</button>
        <input id="search" placeholder="Cari WO, Customer, atau Territory..." oninput="applyFilter()">
        <div class="filter-group">
            <strong>Tampilkan:</strong>
            <label><input type="radio" name="fStatus" value="active" checked onchange="applyFilter()"> Active</label>
            <label><input type="radio" name="fStatus" value="all" onchange="applyFilter()"> All</label>
            <label><input type="radio" name="fStatus" value="New" onchange="applyFilter()"> New</label>
            <label><input type="radio" name="fStatus" value="In Progress" onchange="applyFilter()"> In Progress</label>
            <label><input type="radio" name="fStatus" value="Invoice (Unpaid)" onchange="applyFilter()"> Unpaid</label>
            <label><input type="radio" name="fStatus" value="Close" onchange="applyFilter()"> Close</label>
            <label><input type="radio" name="fStatus" value="Invoice (Claim Submitted)" onchange="applyFilter()"> Claim Submitted</label>
        </div>
    </div>

    <div class="table-container">
        <table>
            <thead>
                <tr>
                    <th>WO</th><th>Customer</th><th>Status</th><th>Sub Status</th><th>Warranty</th><th>Tipe</th><th>Territory</th><th>Model</th><th>Teknisi</th><th>Tanggal</th>
                </tr>
            </thead>
            <tbody id="table"></tbody>
        </table>
    </div>

    <script>
        let DATA = [];
        let CURRENT_FILTERED = [];
        let socket;

        function connectWS() {
            const protocol = location.protocol === "https:" ? "wss://" : "ws://";
            socket = new WebSocket(protocol + location.host);
            socket.onmessage = (e) => {
                const res = JSON.parse(e.data);
                document.getElementById("auth-alert").style.display = res.error === "AUTH_EXPIRED" ? "block" : "none";
                document.getElementById("status-ws").innerText = "Last Sync: " + res.time;
                DATA = res.items;
                updateSummary();
                applyFilter();
            };
            socket.onclose = () => setTimeout(connectWS, 3000);
        }

        function updateSummary() {
            const counts = { New: 0, Progress: 0, Unpaid: 0 };
            DATA.forEach(x => {
                if (x.status === "New") counts.New++;
                if (x.status === "In Progress") counts.Progress++;
                if (x.status === "Invoice (Unpaid)") counts.Unpaid++;
            });
            document.getElementById("summary").innerHTML = \`
                <span class="badge new">New: \${counts.New}</span>
                <span class="badge progress">In Progress: \${counts.Progress}</span>
                <span class="badge unpaid">Unpaid: \${counts.Unpaid}</span>
            \`;
        }

        function applyFilter() {
            const s = document.getElementById("search").value.toLowerCase();
            const filterVal = document.querySelector('input[name="fStatus"]:checked').value;

            CURRENT_FILTERED = DATA.filter(x => {
                const matchSearch = x.wo.toLowerCase().includes(s) || 
                                   (x.customer || "").toLowerCase().includes(s) || 
                                   (x.territory || "").toLowerCase().includes(s);
                let matchStatus = false;
                if (filterVal === "all") matchStatus = true;
                else if (filterVal === "active") matchStatus = ["New", "In Progress", "Invoice (Unpaid)"].includes(x.status);
                else matchStatus = x.status === filterVal;
                return matchSearch && matchStatus;
            });
            renderTable(CURRENT_FILTERED);
        }

        function renderTable(list) {
            const tbody = document.getElementById("table");
            tbody.innerHTML = list.map(x => {
                let rowClass = "";
                if (x.status === "New") rowClass = "row-new";
                else if (x.status === "In Progress") rowClass = "row-progress";
                else if (x.status === "Invoice (Unpaid)") rowClass = "row-unpaid";

                return \`
                <tr class="\${rowClass}">
                    <td><a href="https://cakrawala.id.panasonic.com/partner/work-order/\${x.id}/update" target="_blank">\${x.wo}</a></td>
                    <td>\${x.customer || ""}</td>
                    <td><b>\${x.status}</b></td>
                    <td>\${x.subStatus || ""}</td>
                    <td>\${x.garansi || ""}</td>
                    <td>\${x.tipe || ""}</td>
                    <td>\${x.territory || ""}</td>
                    <td>\${x.model || ""}</td>
                    <td>\${x.teknisi || ""}</td>
                    <td>\${x.created_fmt}</td>
                </tr>\`;
            }).join("");
        }

        function exportToExcel() {
            if (CURRENT_FILTERED.length === 0) return alert("Data kosong");
            const mapped = CURRENT_FILTERED.map(x => ({
                "Nomor WO": x.wo, "Customer": x.customer, "Status": x.status, "Sub Status": x.subStatus,
                "Warranty": x.garansi, "Tipe": x.tipe, "Territory": x.territory, "Model": x.model,
                "Teknisi": x.teknisi, "Tanggal": x.created_fmt
            }));
            const ws = XLSX.utils.json_to_sheet(mapped);
            const wb = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(wb, ws, "WO");
            XLSX.writeFile(wb, "Export_WO_" + new Date().getTime() + ".xlsx");
        }

        connectWS();
    </script>
</body>
</html>
    `);
});

const server = app.listen(PORT, () => console.log("Server running on port " + PORT));
const wss = new WebSocket.Server({ server });

async function broadcast() {
    const result = await fetchAll();
    const payload = JSON.stringify({
        error: result.error,
        items: result.items.map(x => {
            let finalStatus = x.status?.name || "";
            if (x.subStatus?.name === "Invoice (Unpaid)") finalStatus = "Invoice (Unpaid)";
            if (x.subStatus?.name === "Invoice (Claim Submitted)") finalStatus = "Invoice (Claim Submitted)";

            return {
                id: x.id, wo: x.woNumber, customer: x.customer?.accountName, territory: x.territory?.accountName,
                status: finalStatus, subStatus: x.subStatus?.name, garansi: x.asset?.inWarrantyStatus,
                tipe: x.jobType, model: x.asset?.name, teknisi: x.subject,
                created_fmt: new Date(x.createdAt).toLocaleString("id-ID")
            };
        }),
        time: new Date().toLocaleTimeString()
    });
    wss.clients.forEach(client => { if (client.readyState === WebSocket.OPEN) client.send(payload); });
}

setInterval(broadcast, 15000);
broadcast();