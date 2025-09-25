import { serve } from "https://deno.land/std@0.155.0/http/server.ts";

async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  url.protocol = "https:"; // 传输协议
  url.hostname = "translate.googleapis.com"; // 反代域名
  url.port = "443"; // 访问端口
  return await fetch(url.href, {
    headers: req.headers,
    method: req.method,
    body: req.body,
  });
}

serve(handler);
