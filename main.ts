// proxy.ts
import { serve } from "https://deno.land/std@0.211.0/http/server.ts";

/**
 * 处理 CONNECT 请求，建立 TCP 隧道。
 * 这部分是标准转发代理所必需的，与Cloudflare Worker方案不同。
 * @param req 接收到的 Request 对象
 * @param conn 原始的 Deno.Conn 连接
 * @param bufReader 可选的用于读取剩余请求体的缓冲区
 */
async function handleConnect(req: Request, conn: Deno.Conn, bufReader?: Deno.Buffer) {
  const url = new URL(req.url); // CONNECT 请求的 URL 格式是 http://hostname:port
  const hostname = url.hostname;
  const port = url.port || "443"; // 默认 HTTPS 端口

  console.log(`[CONNECT] Received request to tunnel to ${hostname}:${port}`);

  let targetConn: Deno.Conn | undefined;
  try {
    targetConn = await Deno.connect({ hostname, port: parseInt(port) });
    console.log(`[CONNECT] Successfully connected to target ${hostname}:${port}`);

    // 给客户端返回 200 Connection Established 响应
    await conn.write(new TextEncoder().encode("HTTP/1.1 200 Connection Established\r\n\r\n"));

    // 如果 onUpgrade 提供了 bufReader (用于 WebSocket, 但 CONNECT 通常不会有 body)
    // 需要确保 bufReader 中的数据被发送到目标，或处理掉
    if (bufReader && bufReader.length > 0) {
        // CONNECT 请求不应有 body，如果误读了，这里需要处理一下
        // 通常可以忽略，或者在调试时打印出来
        console.warn("[CONNECT] bufReader has data, which is unexpected for CONNECT.");
    }
    
    // 建立双向数据流
    const clientToTarget = Deno.copy(conn, targetConn);
    const targetToClient = Deno.copy(targetConn, conn);

    await Promise.race([clientToTarget, targetToClient]);
    console.log(`[CONNECT] Tunnel closed for ${hostname}:${port}`);

  } catch (error) {
    console.error(`[CONNECT] Tunnel failed for ${hostname}:${port}: ${error}`);
    try {
      await conn.write(new TextEncoder().encode("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 22\r\n\r\nProxy connection failed"));
    } catch (_) { /* ignore errors on error response */ }
  } finally {
    try {
      targetConn?.close();
      conn.close(); // 确保客户端连接也关闭
    } catch (_) { /* ignore errors on closing connections */ }
  }
}

/**
 * 处理普通的 HTTP 请求（GET, POST, etc.），并根据 pathname 重写目标 URL，实现转发。
 * 这是借鉴Cloudflare Worker思路的地方。
 * @param req 接收到的 Request 对象
 */
async function handleHttpRequest(req: Request): Promise<Response> {
  console.log(`[HTTP] Original request: ${req.method} ${req.url}`);

  try {
    let url = new URL(req.url); // 客户端请求的完整 URL (对于HTTP请求) 或带主机名的路径 (对于一些特殊情况)
    let originalHostname = url.hostname; // 保存原始主机名

    // ====== Cloudflare Worker 方案的核心逻辑 ======
    // 根据 pathname 修改目标主机名
    if (url.pathname.startsWith('/translate_a/') || url.pathname.startsWith('/translate_tts') || url.pathname.startsWith('/translate')) {
      url.hostname = "translate.googleapis.com";
      // 保持原始协议，通常这里是HTTPS，因为浏览器最终会请求到googleapis
      url.protocol = "https:"; 
    } else {
      url.hostname = "translate.google.com";
      url.protocol = "https:"; // 保持原始协议
    }
    // ============================================

    console.log(`[HTTP] Rewritten target: ${url.toString()}`);

    // 构建转发请求
    const proxyReq = new Request(url.toString(), {
      method: req.method,
      headers: req.headers,
      body: req.body,
      // duplex: "half" 是 Deno fetch 处理 Request body 的必要参数
      duplex: 'half' as RequestDuplex, // 类型断言来解决 TypeScript 报错
      redirect: "manual", // 让浏览器客户端处理重定向
    });
    
    // 移除代理相关的头部，如 Proxy-Connection
    proxyReq.headers.delete('Proxy-Connection');
    // 如果原始请求Host头不是我们修改后的，则更新Host头
    if (proxyReq.headers.get('Host') === originalHostname) {
        proxyReq.headers.set('Host', url.hostname);
    }
    
    const response = await fetch(proxyReq);
    console.log(`[HTTP] Forwarded ${req.method} ${req.url} -> ${url.hostname} Status ${response.status}`);
    
    // ====== 添加 CORS 头部，此部分也来自 Cloudflare Worker 方案 ======
    let new_response = new Response(response.body, response);
    new_response.headers.set("Access-Control-Allow-Origin", "*");
    new_response.headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    new_response.headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
    // =============================================================

    return new_response;

  } catch (e) {
    console.error(`[HTTP] Proxy error for ${req.url}: ${e.message}`);
    return new Response(`Proxy error: ${e.message}`, { status: 500 });
  }
}

console.log("Deno proxy listening on :8000");

// 使用 Deno.serve 启动 HTTP 服务器
await serve(async (req, connInfo) => {
    // 如果是 CONNECT 请求，且 onUpgrade 没有处理，则报错（理论上 onUpgrade 应该会处理）
    if (req.method === "CONNECT") {
        return new Response("This proxy only supports CONNECT via onUpgrade callback.", { status: 405 });
    }
    // 其他所有 HTTP 请求都由 handleHttpRequest 处理
    return handleHttpRequest(req);
}, {
    port: 8000,
    // onUpgrade 回调在接收到协议升级请求时调用 (如 CONNECT 或 WebSocket)
    onUpgrade: async (req, conn, bufr) => {
        if (req.method === "CONNECT") {
            await handleConnect(req, conn, bufr);
        } else {
            console.warn(`Unexpected upgrade request received: ${req.method}. Not supported.`);
             try {
                await conn.write(new TextEncoder().encode("HTTP/1.1 400 Bad Request\r\n\r\n"));
                conn.close();
            } catch (_) { /* ignore close errors */ }
        }
    },
});

