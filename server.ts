import { createServer, IncomingMessage, ServerResponse } from "http";
import { readFile, stat } from "fs/promises";
import { extname, join } from "path";
import { WebSocketServer, WebSocket } from "ws";
import { Boom } from "@hapi/boom";

import {
	Browsers,
	DisconnectReason,
	makeCacheableSignalKeyStore,
	makeWASocket,
	useMultiFileAuthState,
	WASocket,
} from "baileys";

const PORT = process.env.PORT || 3000;
const WEB_DIR = join(process.cwd(), "web");

const activeSockets = new Map<string, WASocket>();
const clients = new Map<string, WebSocket>();

// Debug helper function
function debugLog(context: string, message: string, data?: any) {
	const timestamp = new Date().toISOString();
	console.log(
		`[${timestamp}] [${context}] ${message}`,
		data ? JSON.stringify(data, null, 2) : ""
	);
}

async function restartWhatsAppConnection(phone: string) {
	debugLog("RESTART", `Restarting connection for phone: ${phone}`);

	const existingSocket = activeSockets.get(phone);
	if (existingSocket) {
		debugLog("RESTART", `Ending existing socket for ${phone}`);
		existingSocket.end(undefined);
		activeSockets.delete(phone);
	}

	await new Promise(resolve => setTimeout(resolve, 2000));
	startWhatsAppConnection(phone);
}

async function startWhatsAppConnection(phone: string) {
	debugLog("CONNECTION", `Starting WhatsApp connection for phone: ${phone}`);

	const clientWs = clients.get(phone);
	debugLog("CONNECTION", `Client WebSocket status:`, {
		exists: !!clientWs,
		readyState: clientWs?.readyState,
		readyStateText:
			clientWs?.readyState === WebSocket.OPEN
				? "OPEN"
				: clientWs?.readyState === WebSocket.CONNECTING
				? "CONNECTING"
				: clientWs?.readyState === WebSocket.CLOSING
				? "CLOSING"
				: clientWs?.readyState === WebSocket.CLOSED
				? "CLOSED"
				: "UNKNOWN",
	});

	const { state, saveCreds } = await useMultiFileAuthState(`session_${phone}`);

	const sock = makeWASocket({
		auth: {
			creds: state.creds,
			keys: makeCacheableSignalKeyStore(state.keys),
		},
		browser: Browsers.macOS("Chrome"),
		printQRInTerminal: false,
	});

	activeSockets.set(phone, sock);
	debugLog("CONNECTION", `Socket created and stored for ${phone}`);

	sock.ev.on("creds.update", saveCreds);

	sock.ev.on("connection.update", async update => {
		const { connection, lastDisconnect, qr } = update;
		const clientWs = clients.get(phone);

		debugLog("CONNECTION_UPDATE", `Connection update received:`, {
			connection,
			hasLastDisconnect: !!lastDisconnect,
			hasQr: !!qr,
			phone,
		});

		if (connection === "open") {
			debugLog("CONNECTION_OPEN", `Connection is open for ${phone}`);
			if (clientWs && clientWs.readyState === WebSocket.OPEN) {
				const message = {
					type: "connection-ready",
					redirect: "/chat",
				};
				debugLog("CONNECTION_OPEN", `Sending connection-ready message:`, message);
				try {
					clientWs.send(JSON.stringify(message));
					debugLog("CONNECTION_OPEN", `Message sent successfully`);
				} catch (error) {
					debugLog("CONNECTION_OPEN", `Failed to send message:`, error);
				}
			}
		}

		if (connection === "close") {
			const reason = lastDisconnect?.error as Boom;
			const shouldReconnect =
				reason?.output?.statusCode !== DisconnectReason.loggedOut;

			debugLog("CONNECTION_CLOSE", `Connection closed:`, {
				phone,
				reasonStatusCode: reason?.output?.statusCode,
				shouldReconnect,
			});

			activeSockets.delete(phone);

			if (reason?.output?.statusCode === DisconnectReason.restartRequired) {
				if (clientWs && clientWs.readyState === WebSocket.OPEN) {
					clientWs.send(
						JSON.stringify({
							type: "restarting",
							message: "Connection restarting...",
						})
					);
				}
				restartWhatsAppConnection(phone);
				return;
			}

			if (shouldReconnect) {
				if (clientWs && clientWs.readyState === WebSocket.OPEN) {
					clientWs.send(
						JSON.stringify({
							type: "reconnecting",
							message: "Reconnecting...",
						})
					);
				}
				startWhatsAppConnection(phone);
			} else {
				if (clientWs && clientWs.readyState === WebSocket.OPEN) {
					clientWs.send(
						JSON.stringify({
							type: "error",
							message: "Connection logged out. Please pair again.",
						})
					);
				}
			}
		}

		if (qr) {
			debugLog("QR_CODE", `QR code received for ${phone}`);
			if (clientWs && clientWs.readyState === WebSocket.OPEN) {
				clientWs.send(JSON.stringify({ type: "qr-code", qr }));
				debugLog("QR_CODE", `QR code sent to client`);
			}
		}
	});

	if (!sock.authState.creds.registered) {
		debugLog("PAIRING", `Requesting pairing code for ${phone}`);
		await new Promise(resolve => setTimeout(resolve, 1500));
		try {
			const code = await sock.requestPairingCode(phone);
			debugLog("PAIRING", `Pairing code received: ${code}`);
			const clientWs = clients.get(phone);
			if (clientWs && clientWs.readyState === WebSocket.OPEN) {
				clientWs.send(JSON.stringify({ type: "pairing-code", code }));
				debugLog("PAIRING", `Pairing code sent to client`);
			}
		} catch (error) {
			debugLog("PAIRING", `Failed to request pairing code for ${phone}:`, error);
		}
	}
}

const MIME_TYPES: { [key: string]: string } = {
	".html": "text/html",
	".css": "text/css",
	".js": "application/javascript",
	".json": "application/json",
	".png": "image/png",
	".jpg": "image/jpeg",
	".svg": "image/svg+xml",
};

const server = createServer(async (req, res) => {
	const url = new URL(req.url!, `http://${req.headers.host}`);

	if (url.pathname === "/pair" && req.method === "POST") {
		let body = "";
		req.on("data", chunk => (body += chunk.toString()));
		req.on("end", async () => {
			try {
				const { phone } = JSON.parse(body);
				debugLog("PAIR_REQUEST", `Received pairing request:`, { phone });

				if (!phone) {
					res.writeHead(400, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ message: "Phone number required." }));
					return;
				}

				res.writeHead(202, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ message: "Connection process initiated." }));
				startWhatsAppConnection(phone);
			} catch (error) {
				debugLog("PAIR_REQUEST", `Error processing pair request:`, error);
				if (!res.headersSent) {
					res.writeHead(500, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ message: "Internal Server Error" }));
				}
			}
		});
		return;
	}

	if (url.pathname === "/restart" && req.method === "POST") {
		let body = "";
		req.on("data", chunk => (body += chunk.toString()));
		req.on("end", async () => {
			try {
				const { phone } = JSON.parse(body);
				debugLog("RESTART_REQUEST", `Received restart request:`, { phone });

				if (!phone) {
					res.writeHead(400, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ message: "Phone number required." }));
					return;
				}
				res.writeHead(202, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ message: "Restart initiated." }));
				restartWhatsAppConnection(phone);
			} catch (error) {
				debugLog("RESTART_REQUEST", `Error processing restart request:`, error);
				if (!res.headersSent) {
					res.writeHead(500, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ message: "Internal Server Error" }));
				}
			}
		});
		return;
	}

	if (url.pathname === "/chat") {
		const filePath = join(WEB_DIR, "chat.html");
		try {
			const stats = await stat(filePath);
			if (!stats.isFile()) {
				res.writeHead(404).end("Not Found");
				return;
			}
			const data = await readFile(filePath);
			res.writeHead(200, {
				"Content-Type": "text/html",
				"Content-Length": data.length,
			});
			res.end(data);
		} catch (error) {
			res.writeHead(
				(error as NodeJS.ErrnoException).code === "ENOENT" ? 404 : 500
			);
			res.end(
				(error as NodeJS.ErrnoException).code === "ENOENT"
					? "Not Found"
					: "Internal Server Error"
			);
		}
		return;
	}

	try {
		const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
		const filePath = join(WEB_DIR, pathname);

		if (!filePath.startsWith(WEB_DIR)) {
			res.writeHead(403).end("Forbidden");
			return;
		}
		const stats = await stat(filePath);
		if (!stats.isFile()) {
			res.writeHead(404).end("Not Found");
			return;
		}
		const data = await readFile(filePath);
		const contentType =
			MIME_TYPES[extname(filePath).toLowerCase()] || "application/octet-stream";
		res.writeHead(200, {
			"Content-Type": contentType,
			"Content-Length": data.length,
		});
		res.end(data);
	} catch (error) {
		res.writeHead((error as NodeJS.ErrnoException).code === "ENOENT" ? 404 : 500);
		res.end(
			(error as NodeJS.ErrnoException).code === "ENOENT"
				? "Not Found"
				: "Internal Server Error"
		);
	}
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws: WebSocket, req) => {
	const url = new URL(req.url!, `http://${req.headers.host}`);
	const phone =
		url.pathname.split("/")[2] || Math.random().toString(36).substr(2, 9);

	debugLog("WEBSOCKET", `New WebSocket connection established: ${phone}`);

	ws.on("message", (data: Buffer) => {
		try {
			const message = JSON.parse(data.toString());
			debugLog("WEBSOCKET_MESSAGE", `Received message on ${phone}:`, message);

			if (message.type === "register" && message.phone) {
				clients.set(message.phone, ws);
				debugLog("WEBSOCKET_REGISTER", `Client registered:`, {
					phone: message.phone,
					totalClients: clients.size,
				});
			}

			if (message.type === "restart" && message.phone) {
				debugLog("WEBSOCKET_RESTART", `Restart requested via WebSocket:`, {
					phone: message.phone,
				});
				restartWhatsAppConnection(message.phone);
			}

			if (message.type === "message" && message.phone && message.text) {
				const sock = activeSockets.get(message.phone);
				if (sock) {
					// Placeholder for actual message sending logic
					const clientWs = clients.get(message.phone);
					if (clientWs && clientWs.readyState === WebSocket.OPEN) {
						clientWs.send(
							JSON.stringify({
								type: "message",
								isSent: true,
								text: message.text,
							})
						);
					}
				}
			}
		} catch (error) {
			debugLog("WEBSOCKET_ERROR", `Error parsing message on ${phone}:`, error);
			ws.send(
				JSON.stringify({ type: "error", message: "Invalid message format" })
			);
		}
	});

	ws.on("close", () => {
		debugLog("WEBSOCKET_CLOSE", `WebSocket connection closed: ${phone}`, {
			phone,
			wasRegistered: !!clients.has(phone),
		});

		if (clients.has(phone)) {
			clients.delete(phone);
			debugLog("WEBSOCKET_CLOSE", `Client removed from registry`, {
				phone,
				remainingClients: clients.size,
			});
		}
	});

	ws.on("error", error => {
		debugLog("WEBSOCKET_ERROR", `WebSocket error on ${phone}:`, error);
	});
});

server.listen(PORT, () => {
	debugLog("SERVER", `HTTP server running: http://localhost:${PORT}`);
});
