import { RawData, WebSocket, WebSocketServer } from "ws";
import { ExtraceRecieveData, outputChannel } from "./shared";
import { commands, window, workspace } from "vscode";
import format from "./format";

export let wss: WebSocketServer | undefined;

export const sockets = new Set<WebSocket>();

const enum CloseCode {
    POLICY_VIOLATION = 1008
}
export const moduleCache: string[] = [];
let nonceCounter = 8485;

export async function sendToSockets(data: { type: string, data: unknown; }) {
    if (sockets.size === 0) {
        throw new Error("No Discord Clients Connected! Make sure you have Discord open, and have the DevCompanion plugin enabled (see README for more info!)");
    }

    const nonce = nonceCounter++;
    (data as any).nonce = nonce;

    const promises = Array.from(sockets, sock => new Promise<void>((resolve, reject) => {
        const onMessage = (data: RawData) => {
            console.log("b");
            const msg = data.toString("utf-8");
            try {
                var parsed = JSON.parse(msg);
            } catch (err) {
                return reject("Got Invalid Response: " + msg);
            }

            if (parsed.nonce !== nonce) return;

            cleanup();

            if (parsed.ok) {
                resolve();
            } else {
                reject(parsed.error);
            }
        };

        const onError = (err: Error) => {
            cleanup();
            reject(err);
        };

        const cleanup = () => {
            sock.off("message", onMessage);
            sock.off("error", onError);
        };

        sock.on("message", onMessage);
        sock.once("error", onError);

        setTimeout(() => {
            cleanup();
            reject("Timed out");
        }, 5000);

        sock.send(JSON.stringify(data));
    }));

    await Promise.all(promises);
    return true;
}

export function startWebSocketServer() {
    wss = new WebSocketServer({
        port: 8485
    });

    wss.on("connection", (sock, req) => {
        if (req.headers.origin) {
            try {
                switch (new URL(req.headers.origin).hostname) {
                    case "discord.com":
                    case "canary.discord.com":
                    case "ptb.discord.com":
                        break;
                    default:
                        throw "a party";
                }
            } catch {
                outputChannel.appendLine(`[WS] Rejected request from invalid or disallowed origin: ${req.headers.origin}`);
                sock.close(CloseCode.POLICY_VIOLATION, "Invalid or disallowed origin");
                return;
            }
        }

        outputChannel.appendLine(`[WS] New Connection (Origin: ${req.headers.origin || "-"})`);
        sockets.add(sock);

        sock.on("close", () => {
            outputChannel.appendLine("[WS] Connection Closed");
            sockets.delete(sock);
        });

        sock.on("message", async msg => {
            console.log("a");
            try {
                const rec = JSON.parse(msg.toString());
                switch (rec.type) {
                    case "extract": {
                        const data: ExtraceRecieveData = rec;
                        if (data.data) {
                            data.data = `//WebpackModule${data.moduleNumber}\n${data.find ? `//OPEN FULL MODULE: ${data.moduleNumber}\n` : ""}//EXTRACED WEPBACK MODULE ${data.moduleNumber}\n 0,\n${data.data}`
                        }
                        workspace.openTextDocument({
                            content: await format(data.data) || "ERROR: NO DATA RECIVED",
                            language: "javascript"
                        })
                            .then(e => {
                                commands.executeCommand("vscode.open", e.uri)
                            }
                            )
                        break;
                    }
                    case "moduleList": {
                        // should be something like ["123", "58913"]
                        moduleCache.length = 0;
                        moduleCache.push(...rec.data);
                        break;
                    }
                }
            }
            catch (e) {
                console.error(e)
                outputChannel.appendLine(String(e));
            }
        });

        sock.on("error", err => {
            console.error("[Vencord Companion WS", err);
            outputChannel.appendLine(`[WS] Error: ${err}`);
        });

        const originalSend = sock.send;
        sock.send = function (data) {
            outputChannel.appendLine(`[WS] SEND: ${data}`);
            // @ts-ignore "Expected 3-4 arguments but got 2?????" No bestie it expects 2-3....
            originalSend.call(this, data);
        };

        console.log(sock);
    });

    wss.on("error", err => {
        console.error("[Vencord Companion WS", err);
        outputChannel.appendLine(`[WS] Error: ${err}`);
    });

    wss.once("listening", () => {
        outputChannel.appendLine("[WS] Listening on port 8485");
    });

    wss.on("close", () => {
        outputChannel.appendLine("[WS] Closed");
    });
}

export function stopWebSocketServer() {
    wss?.close();
    wss = undefined;
}

function handleError(data: ExtraceRecieveData) {
    window.showErrorMessage(data.data || "NO ERROR DATA");
}
