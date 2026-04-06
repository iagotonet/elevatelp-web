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
    const pat = /<(h[1-6]|p|span|div|a|button|li)[^>]*>([\s\S]*?)<\/\1>/gi;
    let m;
    while ((m = pat.exec(html)) !== null) {
          const t = stripHtml(m[2]).trim();
          if (t.length > 3 && t.length < 500 && !t.match(/^https?:\/\//)) texts.push(t);
    }
    return [...new Set(texts)];
}

function isConfigField(field) {
    const f = field.toLowerCase();
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
    if (f.includes('_background_background') || f.includes('background_color')) return true;
    if (f.includes('_typography_typography') || f.includes('typography_font')) return true;
    if (f.includes('border_border') || f.includes('box_shadow_box_shadow')) return true;
    if (f.includes('gradient_position')) return true;
    if (f.endsWith('_id') || f === '_id') return true;
    if (f.endsWith('_url') || f.endsWith('_link')) return true;
    if (f.endsWith('_image') || f.endsWith('_icon') || f.endsWith('_photo') || f.endsWith('_logo')) return true;
    if (/_(align|alignment|justify|position|layout|display)(_|$)/.test(f)) return true;
    if (/_tablet$|_mobile$|_responsive$/.test(f)) return true;
    return false;
}

function isRealText(val) {
    const v = (val || '').trim();
    if (!v || v.length < 2) return false;
    const junk = new Set(['yes','no','true','false','none','auto','inherit','initial','center','left','right','top','bottom','middle','full','stretch','stacked','framed','h1','h2','h3','h4','h5','h6','classic','gradient','solid','dashed','dotted','custom','normal','bold','italic','uppercase','lowercase','image','recent','inline','block','flex','grid','absolute','relative','fixed','static','hidden','visible','fadeIn','fadeInUp','fadeInDown','slideIn','fast','slow','shrink','text_center','text_left','text_right','min-height','contain','cover','no-repeat','transform','highlight','underline','line-through','overline','pointer','grab','default']);
    if (junk.has(v.toLowerCase())) return false;
    if (/^#[0-9a-fA-F]{3,8}$/.test(v)) return false;
    if (/^https?:\/\//.test(v)) return false;
    if (/^www\./.test(v)) return false;
    if (/^\d+(\.\d+)?(px|em|rem|%|vh|vw|pt|deg|s|ms|B)?$/.test(v)) return false;
    if (/^rgba?\(|^hsla?\(/.test(v)) return false;
    if (/^[a-f0-9]{6,32}$/.test(v)) return false;
    if (/^[a-z0-9_-]+$/.test(v) && v.length <= 20 && !v.includes(' ')) return false;
    if (/^\+?\d[\d\s().-]{6,}$/.test(v)) return false;
    if (/@[a-z]+\.[a-z]+/.test(v)) return false;
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
                                        const key = eid + ':' + field;
                                        if (!seen.has(key) && isRealText(clean)) {
                                                      seen.add(key);
                                                      texts.push({ elId: eid, wt, field, text: clean, rawHtml: val.includes('<') });
                                        }
                            } else if (Array.isArray(val)) {
                                        val.forEach((item, idx) => {
                                                      if (!item || typeof item !== 'object') return;
                                                      for (const [sf, sv] of Object.entries(item)) {
                                                                      if (isConfigField(sf)) continue;
                                                                      const key2 = eid + ':' + field + ':' + idx + ':' + sf;
                                                                      if (seen.has(key2) || typeof sv !== 'string') continue;
                                                                      const clean = stripHtml(sv);
                                                                      if (isRealText(clean)) {
                                                                                        seen.add(key2);
                                                                                        texts.push({ elId: eid, wt, listKey: field, idx, sub: sf, text: clean, rawHtml: sv.includes('<') });
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

function applyTexts(jsonData, texts, copies) {
    const adapted = JSON.parse(JSON.stringify(jsonData));
    function applyOne(t, newText) {
          const r = Array.isArray(adapted) ? adapted : (adapted.content || []);
          function w(els) {
                  if (!Array.isArray(els)) return false;
                  for (const el of els) {
                            if (!el || typeof el !== 'object') continue;
                            if (el.id === t.elId) {
                                        const s = el.settings || {};
                                        if (t.listKey) {
                                                      const lst = s[t.listKey];
                                                      if (Array.isArray(lst) && lst[t.idx] !== undefined) {
                                                                      lst[t.idx][t.sub] = t.rawHtml ? '<p>' + newText + '</p>' : newText;
                                                                      return true;
                                                      }
                                        } else if (t.field === 'editor') {
                                                      s.editor = '<p>' + newText + '</p>'; return true;
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
          if (copies[i] && applyOne(texts[i], copies[i])) count++;
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
    for (let i = 0; i < expected; i++) { if (!result[i]) result[i] = null; }
    return result.slice(0, expected);
}

function parseBody(req) {
    return new Promise((resolve, reject) => {
          let body = '';
          req.on('data', c => body += c);
          req.on('end', () => { try { resolve(JSON.parse(body)); } catch(e) { reject(e); } });
    });
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

                                   if (req.method === 'POST' && req.url === '/process') {
                                         try {
                                                 const { pageUrl, jsonData, briefing, clientName } = await parseBody(req);
                                                 if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY nao configurada');
                                                 if (!jsonData) throw new Error('JSON obrigatorio');
                                                 if (!briefing) throw new Error('Briefing obrigatorio');

                                           let pageTexts = [];
                                                 if (pageUrl) {
                                                           try { const html = await fetchUrl(pageUrl); pageTexts = extractPageTexts(html); } catch(e) {}
                                                 }

                                           const parsed = typeof jsonData === 'string' ? JSON.parse(jsonData) : jsonData;
                                                 const texts = extractElementorTexts(parsed);
                                                 if (!texts.length) throw new Error('Nenhum texto encontrado');

                                           const pageContext = pageTexts.length > 0
                                                   ? '\n\nTextos visiveis na pagina (contexto):\n' + pageTexts.slice(0, 20).join('\n')
                                                     : '';

                                           const system = `Você é um copywriter especialista em landing pages de alta conversão para o mercado brasileiro.

                                           Sua tarefa é REESCREVER os textos de um template Elementor para um NEGÓCIO ESPECÍFICO com base no briefing fornecido.

                                           REGRAS ABSOLUTAS:
                                           1. Responda APENAS com a lista numerada, uma linha por item
                                           2. Formato exato: "1. texto reescrito" — NADA mais além da lista
                                           3. TAMANHO: respeite o range [X-Y palavras] indicado — não ultrapasse
                                           4. Use as informações do BRIEFING para criar copy relevante para aquele negócio específico
                                           5. NÃO traduza — REESCREVA com a identidade do negócio do cliente
                                           6. Mencione o nicho, produto, público-alvo e benefícios do BRIEFING
                                           7. Português brasileiro coloquial e persuasivo
                                           8. Para botões/CTAs: use verbos de ação diretos (máximo 4 palavras)
                                           9. Para títulos: use a proposta de valor do negócio, não genéricos
                                           10. Para descrições: mencione benefícios concretos do negócio específico`;

                                           const lines = texts.map((t, i) => {
                                                     const words = t.text.split(/\s+/).filter(w => w).length;
                                                     const min = Math.max(1, Math.floor(words * 0.8));
                                                     const max = Math.ceil(words * 1.2);
                                                     return (i + 1) + '. [' + min + '-' + max + ' palavras] ' + t.text;
                                           });

                                           const userMsg = 'NEGOCIO DO CLIENTE: ' + (clientName || 'nao informado') + '\n\nBRIEFING COMPLETO (USE ESTAS INFORMACOES para criar a copy):\n' + briefing + pageContext + '\n\nTEXTOS DO TEMPLATE PARA REESCREVER (reescreva cada um com a identidade do negocio acima):\n' + lines.join('\n') + '\n\nIMPORTANTE: Cada texto deve refletir diretamente o negocio "' + (clientName || 'do cliente') + '" - nao pode parecer generico ou traduzido.';

                                           const response = await callClaude(system, userMsg);
                                                 const adaptedCopies = parseNumberedList(response, texts.length);
                                                 const { adapted, count } = applyTexts(parsed, texts, adaptedCopies);

                                           const textMap = texts.map((t, i) => ({
                                                     original: t.text, adapted: adaptedCopies[i] || null,
                                                     elId: t.elId, field: t.field || null, listKey: t.listKey || null,
                                                     idx: t.idx !== undefined ? t.idx : null, sub: t.sub || null,
                                                     wt: t.wt, rawHtml: t.rawHtml || false
                                           }));

                                           res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                                                 res.end(JSON.stringify({ success: true, total: texts.length, applied: count, json: adapted, textMap }));
                                         } catch(e) {
                                                 res.writeHead(500, { 'Content-Type': 'application/json' });
                                                 res.end(JSON.stringify({ success: false, error: e.message }));
                                         }
                                         return;
                                   }

                                   if (req.method === 'POST' && req.url === '/fix') {
                                         try {
                                                 const { errorDescription, briefing, clientName, textMap, jsonData } = await parseBody(req);
                                                 if (!briefing) throw new Error('Briefing obrigatorio');

                                           const system = 'Voce corrige erros de copy em landing pages. Responda em JSON: {"fixes":[{"original":"texto errado","corrected":"texto correto","reason":"motivo"}],"newTexts":[{"description":"campo","text":"texto"}]}';
                                                 const textSample = textMap ? textMap.slice(0, 30).map((t, i) => (i+1) + '. [' + t.wt + '] "' + t.original + '" -> "' + (t.adapted || 'NAO ADAPTADO') + '"').join('\n') : '';
                                                 const userMsg = 'EMPRESA: ' + (clientName || 'nao informado') + '\nBRIEFING: ' + briefing + '\n\nPROBLEMA:\n' + errorDescription + (textSample ? '\n\nTEXTOS:\n' + textSample : '') + '\n\nGere as correcoes em JSON.';
                                                 const response = await callClaude(system, userMsg, 'claude-sonnet-4-20250514');
                                                 let fixes = { fixes: [], newTexts: [] };
                                                 try { fixes = JSON.parse(response.replace(/```json|```/gi, '').trim()); } catch(e) {}
                                                 let fixedJson = null;
                                                 if (jsonData && textMap && fixes.fixes && fixes.fixes.length > 0) {
                                                           const parsedJ = typeof jsonData === 'string' ? JSON.parse(jsonData) : jsonData;
                                                           const textsArr = textMap.map(t => ({ elId: t.elId, field: t.field, listKey: t.listKey, idx: t.idx, sub: t.sub, wt: t.wt, rawHtml: t.rawHtml, text: t.original }));
                                                           const correctedCopies = textMap.map(t => {
                                                                       const fix = fixes.fixes.find(f => f.original === t.original || f.original === t.adapted);
                                                                       return fix ? fix.corrected : t.adapted;
                                                           });
                                                           const result = applyTexts(parsedJ, textsArr, correctedCopies);
                                                           fixedJson = result.adapted;
                                                 }
                                                 res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                                                 res.end(JSON.stringify({ success: true, fixes, fixedJson }));
                                         } catch(e) {
                                                 res.writeHead(500, { 'Content-Type': 'application/json' });
                                                 res.end(JSON.stringify({ success: false, error: e.message }));
                                         }
                                         return;
                                   }

                                   res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => console.log('ElevateLP porta ' + PORT));
