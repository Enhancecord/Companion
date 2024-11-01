import { commands, Uri, workspace } from "vscode";
import { RawData, WebSocket, WebSocketServer } from "ws";

import format from "./format";
import { handleAfterRecive } from "./reporter";
import { ExtraceRecieveData, outputChannel } from "./shared";

export let wss: WebSocketServer | undefined;

export const sockets = new Set<WebSocket>();

const enum CloseCode {
  POLICY_VIOLATION = 1008,
}
export const moduleCache: string[] = [];
let nonceCounter = 8485;

export function sendAndGetData<T = any>(data: { type: string; data: unknown }) {
  return new Promise<T>((res, rej) => {
    setTimeout(rej.bind(null, "Timed Out"), 10_000);
    sendToSockets(data, res).catch(rej);
  });
}

export async function sendToSockets(
  data: { type: string; data: unknown },
  dataCb?: (data: any) => void,
) {
  if (sockets.size === 0) {
    throw new Error(
      "No Discord Clients Connected! Make sure you have Discord open, and have the DevCompanion plugin enabled (see README for more info!)",
    );
  }

  const nonce = nonceCounter++;
  (data as any).nonce = nonce;

  const promises = Array.from(
    sockets,
    sock =>
      new Promise<void>((resolve, reject) => {
        const onMessage = (data: RawData) => {
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
            dataCb && dataCb(parsed);
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
      }),
  );

  await Promise.all(promises);
  return true;
}

export function startWebSocketServer() {
  wss = new WebSocketServer({
    port: 8485,
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
        outputChannel.appendLine(
          `[WS] Rejected request from invalid or disallowed origin: ${req.headers.origin}`,
        );
        sock.close(CloseCode.POLICY_VIOLATION, "Invalid or disallowed origin");
        return;
      }
    }

    outputChannel.appendLine(
      `[WS] New Connection (Origin: ${req.headers.origin || "-"})`,
    );
    sockets.add(sock);

    sock.on("close", () => {
      outputChannel.appendLine("[WS] Connection Closed");
      sockets.delete(sock);
    });

    sock.on("message", async msg => {
      try {
        const rec = JSON.parse(msg.toString());
        switch (rec.type) {
          case "report": {
            handleAfterRecive(rec.data);
            break;
          }
          // used to send data back to the sendAndGetData
          case "ret": {
            break;
          }
          case "diff": {
            const { data, moduleNumber } = rec;
            const sourceUri = mkStringUri(
              await format(formatModule(data.source, moduleNumber)),
            );
            const patchedUri = mkStringUri(
              await format(formatModule(data.patched, moduleNumber)),
            );
            commands.executeCommand(
              "vscode.diff",
              sourceUri,
              patchedUri,
              "Patch Diff: " + moduleNumber,
            );
            break;
          }
          case "extract": {
            const data: ExtraceRecieveData = rec;
            if (data.data) {
              data.data = formatModule(data.data, data.moduleNumber, data.find);
            }
            workspace
              .openTextDocument({
                content: await format(
                  data.data ||
                  "//ERROR: NO DATA RECIVED\n//This module may be lazy loaded",
                ),
                language: "javascript",
              })
              .then(e => {
                commands.executeCommand("vscode.open", e.uri);
              });
            break;
          }
          case "moduleList": {
            // should be something like ["123", "58913"]
            moduleCache.length = 0;
            moduleCache.push(...rec.data);
            break;
          }
        }
      } catch (e) {
        console.error(e);
        outputChannel.appendLine(String(e));
      }
    });

    sock.on("error", err => {
      console.error("[Equicord Companion WS", err);
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
    console.error("[Equicord Companion WS", err);
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

/**
 * converts a string into a URI that will resolve to a file with the contents of the string
 * @param patched the contents of the file
 * @param filename the name of the file
 * @param filetype the file extension
 * @returns the Uri for the file
 */
export function mkStringUri(
  patched: any,
  filename = "module",
  filetype = "js",
): Uri {
  const SUFFIX = "/" + filename + "." + filetype;
  if (filename.indexOf("/") !== -1 || filetype.indexOf("/") !== -1)
    throw new Error(
      `Filename and filetype must not contain \`/\`. Got: ${SUFFIX.substring(1)}`,
    );
  const PREFIX = "equicord-companion://b64string/";
  const a = Buffer.from(patched);
  return Uri.parse(PREFIX + a.toString("base64url") + SUFFIX);
}

/**
 * **does not** format the modules code see {@link format} for more code formating

 * takes the raw contents of a module and prepends a header
 * @param moduleContents the module
 * @param moduleId the module id
 * @param isFind if the module is coming from a find
    eg: is it a partial module
 * @returns a string with the formatted module
 */
export function formatModule(
  moduleContents: string,
  moduleId: string | number | undefined = "000000",
  isFind?: boolean,
): string {
  return `//WebpackModule${moduleId}\n${isFind ? `//OPEN FULL MODULE: ${moduleId}\n` : ""}//EXTRACED WEPBACK MODULE ${moduleId}\n 0,\n${moduleContents}`;
}
