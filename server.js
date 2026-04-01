const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ElevateLP/1.0)' }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function stripHtml(h) {
  return (h || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function extractPageTexts(html) {
  html = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
  html = html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
  const texts = [];
  const tagPattern = /<(h[1-6]|p|span|div|a|button|li|td|th|label)[^>]*>([\s\S]*?)<\/\1>/gi;
  let match;
  while ((match = tagPattern.exec(html)) !== null) {
    const text = stripHtml(match[2]).trim();
    if (text.length > 3 && text.length < 500 && !text.match(/^https?:\/\//)) {
      texts.push(text);
    }
  }
  return [...new Set(texts)];
}

// Campos que SÃO configuração (não texto) - apenas sufixos/prefixos técnicos
function isConfigField(field) {
  const f = field.toLowerCase();
  // Campos que terminam em padrões técnicos
  if (/_color$|_colour$/.test(f)) return true;
  if (/_background$|_bg$/.test(f)) return true;
  if (/_font_family$|_font_size$|_font_weight$/.test(f)) return true;
  if (/_line_height$|_letter_spacing$/.test(f)) return true;
  if (/_border_type$|_border_width$|_border_radius$/.test(f)) return true;
  if (/_padding$|_margin$/.test(f)) return true;
  if (/_width$|_height$|_min_height$|_max_width$/.test(f)) return true;
  if (/_opacity$|_z_index$/.test(f)) return true;
  if (/_shadow$|_box_shadow$/.test(f)) return true;
  if (/_animation$|_transition$/.test(f)) return true;
  if (/_gap$|_spacing$/.test(f)) return true;
  // Campos que contêm padrões CSS no meio
  if (f.includes('_background_background') || f.includes('background_color')) return true;
  if (f.includes('_typography_typography') || f.includes('typography_font')) return true;
  if (f.includes('border_border') || f.includes('box_shadow_box_shadow')) return true;
  if (f.includes('gradient_position')) return true;
  // Campos claramente não-texto
  if (f.endsWith('_id') || f === '_id') return true;
  if (f.endsWith('_url') || f.endsWith('_link')) return true;
  if (f.endsWith('_image') || f.endsWith('_icon') || f.endsWith('_photo') || f.endsWith('_logo')) return true;
  // Campos de alinhamento/layout
  if (/_(align|alignment|justify|position|layout|display)(_|$)/.test(f)) return true;
  if (/_tablet$|_mobile$|_responsive$/.test(f)) return true;
  return false;
}

// Verifica se o valor é texto real de conteúdo
function isRealText(val) {
  const v = (val || '').trim();
  if (!v || v.length < 2) return false;
  // Valores técnicos conhecidos
  const junk = new Set(['yes','no','true','false','none','auto','inherit','initial',
    'center','left','right','top','bottom','middle','full','stretch','stacked','framed',
    'h1','h2','h3','h4','h5','h6','classic','gradient','solid','dashed','dotted','custom',
    'normal','bold','italic','uppercase','lowercase','image','recent','inline','block',
    'flex','grid','absolute','relative','fixed','static','hidden','visible',
    'fadeIn','fadeInUp','fadeInDown','slideIn','fast','slow','shrink',
    'text_center','text_left','text_right','min-height','contain','cover','no-repeat',
    'transform','highlight','underline','line-through','overline',
    'style-1','style-2','style-3','style-4','style-5',
    'pointer','grab','default','crosshair','move']);
  if (junk.has(v.toLowerCase())) return false;
  // Padrões técnicos
  if (/^#[0-9a-fA-F]{3,8}$/.test(v)) return false;
  if (/^https?:\/\//.test(v)) return false;
  if (/^www\./.test(v)) return false;
  if (/^\d+(\.\d+)?(px|em|rem|%|vh|vw|pt|deg|s|ms|B)?$/.test(v)) return false;
  if (/^rgba?\(|^hsla?\(/.test(v)) return false;
  if (/^[a-f0-9]{6,32}$/.test(v)) return false; // hex IDs
  if (/^[a-z0-9_-]+$/.test(v) && v.length <= 20 && !v.includes(' ')) return false; // slugs/opcoes
  if (/^\+?\d[\d\s().-]{6,}$/.test(v)) return false; // telefones
  if (/@[a-z]+\.[a-z]+/.test(v)) return false; // emails
  // Deve ter pelo menos 2 letras
  const letters = v.replace(/[^a-zA-ZÀ-ÿ]/g, '');
  if (letters.length < 2) return false;
  return true;
}

function extractElementorTexts(data) {
  const texts = [];
  const seen = new Set();

  function walk(els) {
    if (!Array.isArray(els)) return;
    for (const el of els) {
      if (!el || typeof el !== 'object') continue;
      const wt = el.widgetType || '';
      const s = el.settings || {};
      const eid = el.id || '';
      if (!wt || typeof s !== 'object') { if (el.elements) walk(el.elements); continue; }

      for (const [field, val] of Object.entries(s)) {
        if (isConfigField(field)) continue;

        if (typeof val === 'string') {
          const clean = stripHtml(val);
          const key = `${eid}:${field}`;
          if (!seen.has(key) && isRealText(clean)) {
            seen.add(key);
            texts.push({ elId: eid, wt, field, text: clean, rawHtml: val.includes('<'), applyWt: wt });
          }
        } else if (Array.isArray(val)) {
          val.forEach((item, idx) => {
            if (!item || typeof item !== 'object') return;
            for (const [sf, sv] of Object.entries(item)) {
              if (isConfigField(sf)) continue;
              const key2 = `${eid}:${field}:${idx}:${sf}`;
              if (seen.has(key2) || typeof sv !== 'string') continue;
              const clean = stripHtml(sv);
              if (isRealText(clean)) {
                seen.add(key2);
                texts.push({ elId: eid, wt, listKey: field, idx, sub: sf, text: clean, rawHtml: sv.includes('<'), applyWt: wt });
              }
            }
          });
        }
      }
      if (el.elements) walk(el.elements);
    }
  }

  const root = Array.isArray(data) ? data : (data.content || []);
  walk(root);
  return texts;
}

function applyTexts(jsonData, texts, adaptedCopies) {
  const adapted = JSON.parse(JSON.stringify(jsonData));

  function applyOne(jsonCopy, t, newText) {
    const r = Array.isArray(jsonCopy) ? jsonCopy : (jsonCopy.content || []);
    function w(els) {
      if (!Array.isArray(els)) return false;
      for (const el of els) {
        if (!el || typeof el !== 'object') continue;
        if (el.id === t.elId) {
          const s = el.settings || {};
          if (t.listKey) {
            const lst = s[t.listKey];
            if (Array.isArray(lst) && lst[t.idx] !== undefined) {
              lst[t.idx][t.sub] = t.rawHtml ? `<p>${newText}</p>` : newText;
              return true;
            }
          } else if (t.field === 'editor') {
            s.editor = `<p>${newText}</p>`; return true;
          } else if (t.field) {
            s[t.field] = newText; return true;
          }
        }
        if (el.elements && w(el.elements)) return true;
      }
      return false;
    }
    return w(r);
  }

  let count = 0;
  for (let i = 0; i < texts.length; i++) {
    if (adaptedCopies[i] && applyOne(adapted, texts[i], adaptedCopies[i])) count++;
  }
  return { adapted, count };
}

function callClaude(system, userMsg, model) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model: model || 'claude-haiku-4-5-20251001',
      max_tokens: 8000,
      system,
      messages: [{ role: 'user', content: userMsg }]
    });
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const r = JSON.parse(data);
          if (r.error) reject(new Error(r.error.message));
          else resolve(r.content[0].text.trim());
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(120000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(payload);
    req.end();
  });
}

function parseNumberedList(text, expected) {
  const result = [];
  const lines = text.split('\n');
  for (const line of lines) {
    const m = line.match(/^(\d+)\.\s+(.+)$/);
    if (m) result[parseInt(m[1]) - 1] = m[2].trim();
  }
  for (let i = 0; i < expected; i++) {
    if (!result[i]) result[i] = null;
  }
  return result.slice(0, expected);
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  if (req.method === 'GET' && req.url === '/') {
    const html = fs.readFileSync(path.join(__dirname, 'index.html'));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html); return;
  }

  // Rota principal: processar template
  if (req.method === 'POST' && req.url === '/process') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { pageUrl, jsonData, briefing, clientName } = JSON.parse(body);
        if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY nao configurada');
        if (!jsonData) throw new Error('JSON do Elementor obrigatorio');
        if (!briefing) throw new Error('Briefing obrigatorio');

        let pageTexts = [];
        if (pageUrl) {
          try {
            const html = await fetchUrl(pageUrl);
            pageTexts = extractPageTexts(html);
          } catch(e) { console.log('Aviso pagina:', e.message); }
        }

        const parsed = typeof jsonData === 'string' ? JSON.parse(jsonData) : jsonData;
        const texts = extractElementorTexts(parsed);
        if (texts.length === 0) throw new Error('Nenhum texto encontrado no JSON');

        const pageContext = pageTexts.length > 0
          ? `\n\nTextos visíveis na página:\n${pageTexts.slice(0, 30).join('\n')}`
          : '';

        const system = `Você é um adaptador de copy para landing pages brasileiras.
REGRAS:
1. Responda APENAS com a lista numerada, uma linha por item
2. Formato: "1. texto adaptado" — nada mais
3. TAMANHO: respeite o range [X-Y palavras] — obrigatório
4. Português brasileiro
5. Adapte para o negócio — não invente serviços inexistentes
6. Sem explicações fora da lista`;

        const lines = texts.map((t, i) => {
          const words = t.text.split(/\s+/).filter(w => w).length;
          const min = Math.max(1, Math.floor(words * 0.8));
          const max = Math.ceil(words * 1.2);
          return `${i+1}. [${min}-${max} palavras] ${t.text}`;
        });

        const userMsg = `EMPRESA: ${clientName || 'não informado'}\nBRIEFING:\n${briefing}${pageContext}\n\nReescreva:\n${lines.join('\n')}`;

        const response = await callClaude(system, userMsg);
        const adaptedCopies = parseNumberedList(response, texts.length);
        const { adapted, count } = applyTexts(parsed, texts, adaptedCopies);

        // Salvar textos para correção posterior
        const textMap = texts.map((t, i) => ({
          original: t.text,
          adapted: adaptedCopies[i] || null,
          elId: t.elId,
          field: t.field || null,
          listKey: t.listKey || null,
          idx: t.idx !== undefined ? t.idx : null,
          sub: t.sub || null,
          wt: t.wt,
          rawHtml: t.rawHtml || false
        }));

        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: true, total: texts.length, applied: count, json: adapted, textMap }));

      } catch(e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
    });
    return;
  }

  // Rota de correção: recebe descrição do erro + briefing e gera textos corrigidos
  if (req.method === 'POST' && req.url === '/fix') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { errorDescription, briefing, clientName, textMap, jsonData } = JSON.parse(body);
        if (!errorDescription) throw new Error('Descrição do erro obrigatória');
        if (!briefing) throw new Error('Briefing obrigatório');

        const system = `Você é um especialista em copywriting para landing pages brasileiras.
Analise os erros reportados e gere textos corrigidos.
Responda em JSON válido com o formato:
{
  "fixes": [
    {"original": "texto original", "corrected": "texto corrigido", "reason": "motivo curto"}
  ],
  "newTexts": [
    {"description": "descrição do campo que faltou", "text": "texto gerado"}
  ]
}`;

        const textSample = textMap ? textMap.slice(0, 30).map((t, i) =>
          `${i+1}. [${t.wt}] Original: "${t.original}" → Adaptado: "${t.adapted || 'NÃO ADAPTADO'}"`
        ).join('\n') : '';

        const userMsg = `EMPRESA: ${clientName || 'não informado'}
BRIEFING: ${briefing}

PROBLEMA REPORTADO:
${errorDescription}

TEXTOS QUE FORAM PROCESSADOS:
${textSample}

Gere as correções necessárias em JSON.`;

        const response = await callClaude(system, userMsg, 'claude-sonnet-4-20250514');

        let fixes = { fixes: [], newTexts: [] };
        try {
          const clean = response.replace(/```json|```/g, '').trim();
          fixes = JSON.parse(clean);
        } catch(e) {
          fixes = { fixes: [], newTexts: [{ description: 'Resposta da IA', text: response }] };
        }

        // Se tiver o JSON original e textMap, aplicar as correções automaticamente
        let fixedJson = null;
        if (jsonData && textMap && fixes.fixes && fixes.fixes.length > 0) {
          const parsed = typeof jsonData === 'string' ? JSON.parse(jsonData) : jsonData;
          const texts = textMap.map(t => ({
            elId: t.elId, field: t.field, listKey: t.listKey,
            idx: t.idx, sub: t.sub, wt: t.wt, rawHtml: t.rawHtml, text: t.original
          }));
          const correctedCopies = textMap.map(t => {
            const fix = fixes.fixes.find(f => f.original === t.original || f.original === t.adapted);
            return fix ? fix.corrected : t.adapted;
          });
          const result = applyTexts(parsed, texts, correctedCopies);
          fixedJson = result.adapted;
        }

        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: true, fixes, fixedJson }));

      } catch(e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
    });
    return;
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => console.log(`ElevateLP porta ${PORT}`));
