import * as vscode from "vscode";
import { fetchQuota, QuotaOverview } from "./quota";

function formatCountdown(target?: Date): string {
    if (!target) return "N/A";
    const diff = target.getTime() - Date.now();
    if (diff <= 0) return "Resetting soon";
    const h = Math.floor(diff / 3600000);
    const m = Math.floor((diff % 3600000) / 60000);
    return h > 0 ? `in ${h}h ${m}m` : `in ${m}m`;
}

export function activate(context: vscode.ExtensionContext): void {
    const bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    bar.command = "antigravityQuota.refresh";
    bar.show();
    context.subscriptions.push(bar);

    let timer: NodeJS.Timeout | undefined;

    const getConfig = () => {
        const c = vscode.workspace.getConfiguration("antigravityQuota");
        return {
            intervalMin: Math.max(1, c.get<number>("refreshIntervalMinutes", 2)),
            threshold: c.get<number>("lowThresholdPercent", 20),
        };
    };

    const updateBar = (overview: QuotaOverview, threshold: number) => {
        const parts: string[] = [];
        let isLow = false;

        if (overview.gemini) {
            parts.push(`$(sparkle) Gemini: ${overview.gemini.percent}%`);
            if (overview.gemini.percent <= threshold) isLow = true;
        }
        if (overview.claude) {
            parts.push(`$(hubot) Claude: ${overview.claude.percent}%`);
            if (overview.claude.percent <= threshold) isLow = true;
        }

        bar.text = parts.join(" | ") || "$(info) Quota: Active";
        bar.backgroundColor = isLow ? new vscode.ThemeColor("statusBarItem.warningBackground") : undefined;

        const md = new vscode.MarkdownString("### Antigravity Model Quotas\n\n", true);
        if (overview.gemini) md.appendMarkdown(`**Gemini**: \`${overview.gemini.percent}%\` (Resets ${formatCountdown(overview.gemini.resetTime)})\n\n`);
        if (overview.claude) md.appendMarkdown(`**Claude**: \`${overview.claude.percent}%\` (Resets ${formatCountdown(overview.claude.resetTime)})\n\n`);
        if (overview.allBuckets.length) {
            md.appendMarkdown("| Model / Window | Remaining | Reset |\n|:--|:--:|:--|\n");
            for (const b of overview.allBuckets) {
                md.appendMarkdown(`| ${b.name} | **${b.percent}%** | ${formatCountdown(b.resetTime)} |\n`);
            }
        }
        md.appendMarkdown(`\n*Updated: ${overview.fetchedAt.toLocaleTimeString()} · Click to refresh*`);
        bar.tooltip = md;
    };

    const refresh = async (silent = false): Promise<void> => {
        if (!silent) {
            bar.text = "$(sync~spin) Quota...";
            bar.tooltip = "Refreshing Antigravity quota...";
            bar.backgroundColor = undefined;
        }
        try {
            const overview = await fetchQuota();
            updateBar(overview, getConfig().threshold);
        } catch (err: any) {
            bar.text = "$(cloud-offline) Quota: Offline";
            bar.tooltip = new vscode.MarkdownString(`### Antigravity Quota: Disconnected\n\n${err?.message || err}\n\n*Click to retry*`, true);
            bar.backgroundColor = undefined;
        }
    };

    const schedule = () => {
        if (timer) clearInterval(timer);
        timer = setInterval(() => void refresh(true), getConfig().intervalMin * 60000);
    };

    context.subscriptions.push(
        vscode.commands.registerCommand("antigravityQuota.refresh", () => void refresh(false)),
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration("antigravityQuota")) { schedule(); void refresh(true); }
        }),
        { dispose: () => { if (timer) clearInterval(timer); } }
    );

    schedule();
    void refresh(false);
}

export function deactivate(): void {}
