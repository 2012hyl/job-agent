// functions/api/proxy.js
// job-agent 专用后端：AI简历生成 + 激活码验证

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

  let body;
  try { body = await request.json(); } catch (e) {
    return new Response(JSON.stringify({ error: 'JSON解析失败' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }

  // ========== 激活码验证 ==========
  if (body.type === 'activate') {
    const code = (body.code || '').toUpperCase().trim();
    if (!code) {
      return new Response(JSON.stringify({ valid: false, message: '请输入激活码' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

    const validCodesStr = env.ACTIVATION_CODES || '';
    const validCodes = validCodesStr.split(',').map(c => c.trim().toUpperCase());

    if (validCodes.includes(code)) {
      return new Response(JSON.stringify({ valid: true, message: '激活成功' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    } else {
      return new Response(JSON.stringify({ valid: false, message: '激活码无效' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }
  }

  // ========== AI生成简历 ==========
  const options = body.options;
  if (!options || !options.name || !options.jobTarget) {
    return new Response(JSON.stringify({ error: '缺少必要参数' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }

  const eduText = `${options.education || ''} | ${options.school || ''} | ${options.major || ''} | ${options.gradYear || ''}年毕业`;

  const systemPrompt = `你是资深HR和简历优化专家。请根据以下信息生成一份专业、简洁的HTML格式简历。
要求：使用HTML标签格式化，结构：头部(姓名+求职意向+联系方式) → 教育背景 → 工作经历 → 项目经历 → 技能 → 其他。每段经历用STAR法则重写，突出量化成果。技能部分用标签形式展示。整体风格专业简洁适合打印。不要写空洞形容词。如果某项内容为空直接跳过。输出完整HTML（从<div>开始），不要DOCTYPE和body标签。

教育背景：${eduText}
工作经历：${options.workExp || '无'}
项目经历：${options.projects || '无'}
技能：${options.skills || '无'}
其他亮点：${options.highlights || '无'}`;

  const userMessage = `请为${options.name}生成一份求职【${options.jobTarget}】的专业简历。联系方式：${options.phone || ''} | ${options.email || ''}`;

  try {
    const aiResponse = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.DEEPSEEK_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'deepseek-v4-flash',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        temperature: 0.5,
        max_tokens: 2000,
        stream: false,
      }),
    });

    const aiData = await aiResponse.json();

    if (aiData.error) {
      return new Response(JSON.stringify({ error: 'AI调用失败' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

    const resumeHTML = aiData.choices[0].message.content;

    return new Response(JSON.stringify({ resume: resumeHTML }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: '服务器错误' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }
}
