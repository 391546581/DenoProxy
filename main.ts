import { serve } from "https://deno.land/std@0.211.0/http/server.ts";
// import * as net from "https://deno.land/std@0.211.0/node/net.ts"; // Deno 的 net 模块用于 TCP 连接

async function handleConnect(req: Request, conn: Deno.Conn) {
    const url = new URL(req.url); // CONNECT 请求的 URL 通常是 http://hostname:port
    const hostname = url.hostname;
    const port = url.port || "443"; // 默认 HTTPS 端口

    console.log(`[CONNECT] Attempting to tunnel to ${hostname}:${port}`);

    let targetConn: DDeno.Conn | undefined;
    try {
        targetConn = await Deno.connect({ hostname, port: parseInt(port) });
        console.log(`[CONNECT] Successfully connected to ${hostname}:${port}`);

        // If connection successful, send 200 OK to client (browser)
        await conn.write(new TextEncoder().encode("HTTP/1.1 200 Connection Established\r\n\r\n"));

        // Now, tunnel data between client and target
        // This is a simplified tunnel, usually needs more robust error handling
        // and concurrent reading/writing.
        // Deno.readableStreamFromReader(conn) and Deno.writableStreamFromWriter(targetConn) can be used.
        const clientToTarget = Deno.copy(conn, targetConn);
        const targetToClient = Deno.copy(targetConn, conn);

        await Promise.race([clientToTarget, targetToClient]);
        console.log(`[CONNECT] Tunnel closed for ${hostname}:${port}`);
    } catch (error) {
        console.error(`[CONNECT] Tunnel failed for ${hostname}:${port}: ${error}`);
        // Send 502 Bad Gateway or similar error to client
        await conn.write(new TextEncoder().encode("HTTP/1.1 502 Bad Gateway\r\n\r\n"));
    } finally {
        try {
            targetConn?.close();
            conn.close(); // Close client connection as well
        } catch (_) { /* ignore errors on close */ }
    }
}

async function handler(req: Request): Promise<Response> {
    // This handler will only be called for non-CONNECT requests
    console.log(`[HTTP] Received ${req.method} ${req.url}`);
    return new Response("This is a proxy server. Send CONNECT requests for tunneling.", { status: 400 });
}

console.log("Deno proxy listening on :8000");
await serve(handler, {
    port: 8000,
    // The onUpgrade callback handles "upgrade" requests like CONNECT and WebSocket
    onUpgrade: async (req, conn, bufr) => {
        if (req.method === "CONNECT") {
             // onUpgrade receives raw Deno.Conn, so we can handle it directly
            await handleConnect(req, conn);
        } else {
            // For other upgrade requests (e.g., WebSockets), you'd handle them here.
            // For now, just close the connection if not CONNECT.
            conn.close();
        }
    },
});
