// proxy.ts
import { serve } from "https://deno.land/std@0.211.0/http/server.ts";

/**
 * 处理 CONNECT 请求，建立 TCP 隧道。
 * @param req 接收到的 Request 对象
 * @param conn 原始的 Deno.Conn 连接
 * @param bufReader 可选的用于读取剩余请求体的缓冲区
 */
async function handleConnect(req: Request, conn: Deno.Conn, bufReader?: Deno.Buffer) {
  // CONNECT 请求的 URL 格式是 http://hostname:port，所以可以直接从 req.url 解析
  const url = new URL(req.url);
  const hostname = url.hostname;
  const port = url.port || "443"; // 默认 HTTPS 端口

  console.log(`[CONNECT] Received request to tunnel to ${hostname}:${port}`);

  let targetConn: Deno.Conn | undefined;
  try {
    // 尝试连接到目标服务器
    targetConn = await Deno.connect({ hostname, port: parseInt(port) });
    console.log(`[CONNECT] Successfully connected to target ${hostname}:${port}`);

    // 给客户端返回 200 Connection Established 响应
    await conn.write(new TextEncoder().encode("HTTP/1.1 200 Connection Established\r\n\r\n"));

    // 如果 onUpgrade 提供了 bufReader (用于 WebSocket, 但 CONNECT 通常不会有 body)
    // 需要确保 bufReader 中的数据被发送到目标，或处理掉
    if (bufReader && bufr.length > 0) {
        // CONNECT 请求不应有 body，如果误读了，这里需要处理一下
        // 通常可以忽略，或者在调试时打印出来
        console.warn("[CONNECT] bufReader has data, which is unexpected for CONNECT.");
    }
    
    // 建立双向数据流
    const clientToTarget = Deno.copy(conn, targetConn);
    const targetToClient = Deno.copy(targetConn, conn);

    // 等待任意一侧连接关闭
    await Promise.race([clientToTarget, targetToClient]);
    console.log(`[CONNECT] Tunnel closed for ${hostname}:${port}`);

  } catch (error) {
    console.error(`[CONNECT] Tunnel failed for ${hostname}:${port}: ${error}`);
    try {
      // 连接目标失败，返回 502 Bad Gateway
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
 * 处理普通的 HTTP 请求（GET, POST, etc.），进行转发。
 * @param req 接收到的 Request 对象
 */
async function handleHttpRequest(req: Request): Promise<Response> {
  console.log(`[HTTP] Received ${req.method} ${req.url}`);

  try {
    const url = new URL(req.url);
    
    // 构造转发请求
    const proxyReq = new Request(url.toString(), {
      method: req.method,
      headers: req.headers,
      body: req.body,
      // duplex: "half" 是 Deno fetch 处理 Request body 的必要参数，当 body 不为 null 时需要
      // https://deno.com/manual@v1.39.0/runtime/http/fetch_api#request-with-body
      duplex: 'half' as RequestDuplex, // 类型断言来解决 TypeScript 报错
      redirect: "manual", // 避免 fetch 自动处理重定向，让浏览器客户端处理
    });
    
    // 移除可能引起问题的头部，例如 Host，让 fetch 自动设置
    // proxyReq.headers.delete('Host'); 
    // Proxy-Connection 也是代理特有的，客户端到代理的头部，转发时应删除
    proxyReq.headers.delete('Proxy-Connection');
    
    const response = await fetch(proxyReq);
    console.log(`[HTTP] Forwarded ${req.method} ${req.url} -> Status ${response.status}`);
    return response;

  } catch (e) {
    console.error(`[HTTP] Proxy error for ${req.url}: ${e.message}`);
    return new Response(`Proxy error: ${e.message}`, { status: 500 });
  }
}

console.log("Deno proxy listening on :8000");

// 使用 Deno.serve 启动 HTTP 服务器
await serve(async (req, connInfo) => {
    // 这里的默认 handler 会处理所有非 CONNECT 的 HTTP 请求。
    // 但是 onUpgrade 会优先被调用。
    // 如果 req.method 是 CONNECT，onUpgrade 会被调用且应该处理它。
    // 如果 onUpgrade 没有处理 CONNECT (例如它返回了 falsey 值)，那这个 handler 也会收到 CONNECT。
    // 所以为了安全起见，确保 onUpgrade 彻底处理 CONNECT，或者在这里再次检查。
    if (req.method === "CONNECT") {
        return new Response("This proxy only supports CONNECT via onUpgrade callback.", { status: 405 });
    }
    return handleHttpRequest(req);
}, {
    port: 8000,
    // onUpgrade 回调在接收到协议升级请求时调用 (如 CONNECT 或 WebSocket)
    onUpgrade: async (req, conn, bufr) => {
        if (req.method === "CONNECT") {
            // 将原始连接交给 handleConnect 函数
            await handleConnect(req, conn, bufr);
        } else {
            console.warn(`Unexpected upgrade request received: ${req.method}`);
            // 对于非 CONNECT 的升级请求，可以根据需要处理或直接关闭
             try {
                // 如果是其他升级请求，但我们不支持，就关闭连接
                await conn.write(new TextEncoder().encode("HTTP/1.1 400 Bad Request\r\n\r\n"));
                conn.close();
            } catch (_) { /* ignore close errors */ }
        }
    },
});

