import * as https from "node:https";
import * as http from "node:http";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const SERVICE = "exa.language_server_pb.LanguageServerService";

export interface QuotaBucket {
    name: string;
    family: "Gemini" | "Claude" | "Other";
    percent: number;
    resetTime?: Date;
    rawFraction: number;
}

export interface FamilyQuota {
    percent: number;
    resetTime?: Date;
    buckets: QuotaBucket[];
}

export interface QuotaOverview {
    gemini?: FamilyQuota;
    claude?: FamilyQuota;
    allBuckets: QuotaBucket[];
    fetchedAt: Date;
}

interface BackendSession {
    pid: number;
    lsPort: number;
    csrfToken: string;
}

let cachedSession: BackendSession | undefined;
let cachedAt = 0;

const parseJson = <T>(s: string): T[] => {
    try { const v = JSON.parse(s.trim()); return Array.isArray(v) ? v : [v]; } catch { return []; }
};

const runPs = async (cmd: string): Promise<string> =>
    (await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", cmd], { windowsHide: true, timeout: 5000 })).stdout.trim();

async function getListeningPorts(pid: number): Promise<number[]> {
    if (process.platform === "win32") {
        const out = await runPs(`Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.OwningProcess -eq ${pid} } | Select-Object -ExpandProperty LocalPort | ConvertTo-Json -Compress`).catch(() => "");
        return parseJson<number>(out).filter(p => Number.isInteger(p) && p > 0);
    }
    const out = await exec("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-a", "-p", String(pid)], { timeout: 3000 }).then(r => r.stdout).catch(() => "");
    return [...new Set(out.split("\n").map(l => parseInt(/[:\]](\d+)\s+\(LISTEN\)/i.exec(l)?.[1] || "", 10)).filter(p => p > 0))];
}

function probeRpc(port: number, csrfToken: string, timeoutMs = 800): Promise<boolean> {
    return new Promise(resolve => {
        const req = https.request(
            { hostname: "127.0.0.1", port, path: `/${SERVICE}/GetUserStatus`, method: "POST", rejectUnauthorized: false, timeout: timeoutMs,
              headers: { "Content-Type": "application/json", "Connect-Protocol-Version": "1", "x-codeium-csrf-token": csrfToken, "Content-Length": 2 } },
            res => { res.resume(); resolve(res.statusCode === 200); }
        );
        req.on("timeout", () => { req.destroy(); resolve(false); });
        req.on("error", () => resolve(false));
        req.write("{}");
        req.end();
    });
}

export async function detectBackend(): Promise<BackendSession> {
    if (cachedSession && Date.now() - cachedAt < 60_000 && await probeRpc(cachedSession.lsPort, cachedSession.csrfToken, 300)) {
        return cachedSession;
    }

    type PInfo = { ProcessId: number; Name?: string; ExecutablePath?: string; CommandLine?: string };
    let procs: PInfo[] = [];

    if (process.platform === "win32") {
        const ps = `Get-CimInstance Win32_Process | Where-Object { ($_.Name -ieq 'agy.exe' -and $_.CommandLine -match '--hub') -or ($_.Name -match '(?i)^language_server' -and $_.CommandLine -match '--csrf_token\\s+([a-f0-9\\-]+)') } | Select-Object ProcessId, Name, ExecutablePath, CommandLine | ConvertTo-Json -Compress`;
        procs = parseJson<PInfo>(await runPs(ps).catch(() => ""));
    } else {
        const out = await exec("ps", ["-eo", "pid,command"], { timeout: 3000 }).then(r => r.stdout).catch(() => "");
        for (const line of out.split("\n").slice(1)) {
            const m = line.trim().match(/^(\d+)\s+(.+)$/);
            if (m && (m[2].includes("--hub") || m[2].includes("language_server"))) procs.push({ ProcessId: parseInt(m[1], 10), CommandLine: m[2] });
        }
    }

    if (!procs.length) throw new Error("No running Antigravity Language Server / agy process found.");

    const appDir = (process.execPath ? path.dirname(process.execPath) : "").toLowerCase();
    const proc = procs.find(p => p.ExecutablePath && path.dirname(p.ExecutablePath).toLowerCase().startsWith(appDir)) ||
                 procs.find(p => /language_server/i.test(p.Name || p.CommandLine || "")) || procs[0];

    const pid = Number(proc.ProcessId);
    const cmd = proc.CommandLine || "";
    let csrfToken = /--csrf_token\s+([a-f0-9\-]+)/i.exec(cmd)?.[1] || "";
    let lsPort: number | undefined;

    const httpsMatch = /--https_server_port\s+(\d+)/i.exec(cmd);
    if (httpsMatch && csrfToken && await probeRpc(Number(httpsMatch[1]), csrfToken, 600)) {
        lsPort = Number(httpsMatch[1]);
    }

    if (!lsPort) {
        const hubPort = Number(/--hub-port=(\d+)/i.exec(cmd)?.[1]);
        if (hubPort && !csrfToken) {
            csrfToken = await new Promise<string>((res, rej) => {
                http.get(`http://127.0.0.1:${hubPort}/`, { timeout: 2000 }, r => {
                    let d = ""; r.on("data", c => d += c);
                    r.on("end", () => { const m = /csrfToken["\s:]+([a-f0-9\-]+)/i.exec(d); m ? res(m[1]) : rej(); });
                }).on("error", rej);
            }).catch(() => "");
        }

        for (const port of await getListeningPorts(pid)) {
            if (csrfToken && await probeRpc(port, csrfToken, 600)) { lsPort = port; break; }
        }
    }

    if (!lsPort || !csrfToken) throw new Error("Could not connect to Antigravity Language Server.");
    cachedSession = { pid, lsPort, csrfToken };
    cachedAt = Date.now();
    return cachedSession;
}

function invokeRpc<T>(port: number, method: string, csrfToken: string, payload: unknown = {}): Promise<T> {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify(payload);
        const req = https.request(
            { hostname: "127.0.0.1", port, path: `/${SERVICE}/${method}`, method: "POST", rejectUnauthorized: false, timeout: 5000,
              headers: { "Content-Type": "application/json", "Connect-Protocol-Version": "1", "x-codeium-csrf-token": csrfToken, "Content-Length": Buffer.byteLength(body) } },
            res => {
                const chunks: Buffer[] = [];
                res.on("data", c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
                res.on("end", () => {
                    const txt = Buffer.concat(chunks).toString("utf8");
                    if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) return reject(new Error(`${method} HTTP ${res.statusCode}: ${txt}`));
                    try { resolve(JSON.parse(txt) as T); } catch { reject(new Error(`${method} returned invalid JSON`)); }
                });
            }
        );
        req.on("timeout", () => { req.destroy(); reject(new Error(`${method} timed out`)); });
        req.on("error", reject);
        req.write(body);
        req.end();
    });
}

const classify = (s: string): "Gemini" | "Claude" | "Other" =>
    /claude|anthropic/i.test(s) ? "Claude" : /gemini/i.test(s) ? "Gemini" : "Other";

const parseTime = (v: any): Date | undefined => {
    if (typeof v === "string" && v) { const d = new Date(v); return isNaN(d.getTime()) ? undefined : d; }
    if (v?.seconds && Number.isFinite(Number(v.seconds))) return new Date(Number(v.seconds) * 1000);
    return undefined;
};

export function parseQuotaBucketsFromSummary(res: any): QuotaBucket[] {
    const buckets: QuotaBucket[] = [];
    for (const b of (Array.isArray(res?.response?.buckets) ? res.response.buckets : [])) {
        if (!b || b.disabled === true || typeof b.remainingFraction !== "number" || !Number.isFinite(b.remainingFraction)) continue;
        const name = String(b.displayName || b.groupDisplayName || b.bucketId || "Model").trim();
        buckets.push({
            name,
            family: classify(`${b.groupDisplayName || ""} ${name}`),
            percent: Math.max(0, Math.min(100, Math.round(b.remainingFraction * 100))),
            resetTime: parseTime(b.resetTime),
            rawFraction: b.remainingFraction,
        });
    }
    return buckets;
}

export function parseQuotaBucketsFromUserStatus(res: any): QuotaBucket[] {
    const buckets: QuotaBucket[] = [];
    for (const c of (Array.isArray(res?.userStatus?.cascadeModelConfigData?.clientModelConfigs) ? res.userStatus.cascadeModelConfigData.clientModelConfigs : [])) {
        const q = c?.quotaInfo;
        if (!q || typeof q.remainingFraction !== "number" || !Number.isFinite(q.remainingFraction)) continue;
        const name = String(c.label || c.modelId || "Model").trim();
        buckets.push({
            name,
            family: classify(name),
            percent: Math.max(0, Math.min(100, Math.round(q.remainingFraction * 100))),
            resetTime: parseTime(q.resetTime),
            rawFraction: q.remainingFraction,
        });
    }
    return buckets;
}

export function buildQuotaOverview(buckets: QuotaBucket[]): QuotaOverview {
    const summarize = (family: "Gemini" | "Claude"): FamilyQuota | undefined => {
        const list = buckets.filter(b => b.family === family);
        if (!list.length) return undefined;
        const future = list.map(b => b.resetTime).filter((d): d is Date => d instanceof Date && d.getTime() > Date.now()).sort((a, b) => a.getTime() - b.getTime());
        return {
            percent: Math.min(...list.map(b => b.percent)),
            resetTime: future[0] || list[0].resetTime,
            buckets: list,
        };
    };

    return { gemini: summarize("Gemini"), claude: summarize("Claude"), allBuckets: buckets, fetchedAt: new Date() };
}

export async function fetchQuota(): Promise<QuotaOverview> {
    const session = await detectBackend();
    let buckets: QuotaBucket[] = [];
    try {
        const sum = await invokeRpc<any>(session.lsPort, "RetrieveUserQuotaSummary", session.csrfToken, { forceRefresh: true });
        buckets = parseQuotaBucketsFromSummary(sum);
    } catch {}

    if (!buckets.length) {
        const st = await invokeRpc<any>(session.lsPort, "GetUserStatus", session.csrfToken);
        buckets = parseQuotaBucketsFromUserStatus(st);
    }

    return buildQuotaOverview(buckets);
}
