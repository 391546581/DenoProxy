
// 打开 Deno KV（全局只需打开一次）
const kv = await Deno.openKv();
// 使用一个固定的 key 来存储目标 URL
const TARGET_KEY = ["targetUrl"];

Deno.serve(async (req) => {
  const url = new URL(req.url);

  // 如果请求带有 setUrl 参数，则更新目标 URL
  if (url.searchParams.has("setUrl")) {
    const newTargetUrl = url.searchParams.get("setUrl")!;
    // 基本校验一下 URL 格式
    try {
      new URL(newTargetUrl);
    } catch {
      return new Response("无效的 URL，请检查格式。", { status: 400 });
    }
    await kv.set(TARGET_KEY, newTargetUrl);
    return new Response(`代理目标 URL 已更新为：${newTargetUrl}`);
  }

  // 仅处理路径以 /proxy 开头的请求
  if (url.pathname.startsWith("/proxy")) {
    // 从 KV 中获取目标 URL
    const result = await kv.get(TARGET_KEY);
    if (!result.value) {
      return new Response(
          "未设置代理目标 URL，请使用 ?setUrl=你的目标URL 进行设置。",
          { status: 400 }
      );
    }
    const baseUrl = result.value as string;

    // 去掉 /proxy 前缀，剩余部分作为相对路径
    const proxyPath = url.pathname.slice("/proxy".length);
    // 构造最终的请求 URL：以存储的 baseUrl 为基准，加上剩余路径和原有查询参数（注意：此处不包括 setUrl 参数，因为已单独处理）
    let finalUrl: string;
    try {
      finalUrl = new URL(proxyPath + url.search, baseUrl).toString();
    } catch {
      return new Response("构造目标 URL 出错。", { status: 500 });
    }

    // 构造一个新的请求，将客户端的 method、headers 和 body 传递过去
    const proxyRequest = new Request(finalUrl, {
      method: req.method,
      headers: req.headers,
      body: req.body,
    });

    try {
      const targetResponse = await fetch(proxyRequest);
      // 使用 arrayBuffer 来支持二进制数据（比如图片等）
      const body = await targetResponse.arrayBuffer();

      // 复制目标响应的 headers
      const responseHeaders = new Headers();
      for (const [key, value] of targetResponse.headers.entries()) {
        responseHeaders.set(key, value);
      }

      return new Response(body, {
        status: targetResponse.status,
        headers: responseHeaders,
      });
    } catch (err) {
      return new Response(`请求目标 URL 时发生错误：${err}`, {
        status: 500,
      });
    }
  }

  // 其他请求返回提示信息
  return new Response(
      "欢迎使用 Deno Proxy：\n" +
      "1. 使用 /proxy 开头的路径发起代理请求。\n" +
      "2. 使用 ?setUrl=你的目标URL 设置代理目标。"
  );
});
