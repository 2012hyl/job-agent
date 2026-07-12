// functions/api/proxy.js
// v2.2：频率限制 + 激活码次数管理 + AI兜底 + 哈希验证答案

// 内存级请求频率限制
const rateLimitMap = new Map();

function checkRateLimit(ip) {
  const now = Date.now();
  const record = rateLimitMap.get(ip) || { count: 0, resetTime: now + 60000 };
  if (now > record.resetTime) {
    record.count = 0;
    record.resetTime = now + 60000;
  }
  record.count++;
  rateLimitMap.set(ip, record);
  return record.count <= 30; // 每分钟最多30次
}

// 简单哈希函数（SHA256降级方案）
function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return Math.abs(hash).toString(16).slice(0, 8);
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    });
  }

  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: '只支持POST' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }

  // 频率限制
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (!checkRateLimit(ip)) {
    return new Response(JSON.stringify({ error: '请求过于频繁，请稍后再试' }), {
      status: 429,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }

  let body;
  try { body = await request.json(); } catch (e) {
    return new Response(JSON.stringify({ error: 'JSON解析失败' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }

  // ========== 激活码两步验证 ==========
  if (body.type === 'activate') {
    const code = (body.code || '').toUpperCase().trim();
    const answer = (body.answer || '').trim();

    if (!code) {
      return new Response(JSON.stringify({ valid: false, message: '请输入激活码', step: 1 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

    // 解析激活码列表：格式 "码:剩余次数,码:剩余次数"
    const codesStr = env.ACTIVATION_CODES || '';
    const codeEntries = codesStr.split(',').map(c => c.trim()).filter(c => c);
    const codeMap = {};
    codeEntries.forEach(entry => {
      const [c, count] = entry.split(':');
      if (c) codeMap[c.toUpperCase()] = parseInt(count || '1');
    });

    if (!codeMap[code] || codeMap[code] <= 0) {
      return new Response(JSON.stringify({ valid: false, message: '激活码无效或已用完', step: 1 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

    if (!answer) {
      return new Response(JSON.stringify({ valid: false, message: '请回答验证问题', step: 2, code: code }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

    // 验证答案：比对哈希
    const correctHash = env.VERIFY_ANSWER_HASH || '1a2b3c4d';
    const answerHash = simpleHash(answer);
    if (answerHash !== correctHash) {
      return new Response(JSON.stringify({ valid: false, message: '验证答案错误', step: 2, code: code }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

    // 扣减激活次数
    codeMap[code]--;
    const newCodesStr = Object.entries(codeMap)
      .map(([c, n]) => c + ':' + n)
      .join(',');
    // 注意：环境变量无法在运行时写回，这里只能读不能写
    // 实际生产中需要用 KV 存储，此处做标记说明

    return new Response(JSON.stringify({ valid: true, message: '激活成功', step: 3 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }

  // ========== AI调用 ==========
  const messages = body.messages;
  const model = body.model || 'deepseek-v4-flash';
  const temperature = body.temperature || 0.5;
  const max_tokens = body.max_tokens || 2000;

  if (!messages || !Array.isArray(messages)) {
    return new Response(JSON.stringify({ error: '缺少messages参数' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }

  try {
    const aiResponse = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.DEEPSEEK_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model, messages, temperature, max_tokens, stream: false }),
    });

    const aiData = await aiResponse.json();

    if (aiData.error) {
      return new Response(JSON.stringify({ error: 'AI接口暂时不可用，请稍后再试' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

    const content = aiData.choices?.[0]?.message?.content || '';

    // AI兜底：返回内容异常短
    if (content.length < 30) {
      return new Response(JSON.stringify({ error: 'AI生成内容异常，请重试。如多次失败请截图联系开发者。' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

    return new Response(JSON.stringify({ content }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: '服务器内部错误，请稍后再试' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }
}
