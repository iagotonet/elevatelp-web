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
    const req = mod.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
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

// Verifica se campo é de configuração visual (NÃO pular no módulo de alterações)
function isConfigField(field) {
  const f = field.toLowerCase();
  if (/_font_family$|_font_size$|_font_weight$/.test(f)) return true;
  if (/_line_height$|_letter_spacing$/.test(f)) return true;
  if (/_border_type$|_border_width$/.test(f)) return true;
  if (/_padding$|_margin$/.test(f)) return true;
  if (/_width$|_height$|_min_height$|_max_width$/.test(f)) return true;
  if (/_opacity$|_z_index$/.test(f)) return true;
  if (/_animation$|_transition$/.test(f)) return true;
  if (/_gap$|_spacing$/.test(f)) return true;
  if (f.includes('_typography_typography') || f.includes('typography_font')) return true;
  if (f.includes('gradient_position')) return true;
  if (f.endsWith('_id') || f === '_id') return true;
  if (/_(align|alignment|justify|layout|display)(_|$)/.test(f)) return true;
  if (/_tablet$|_mobile$|_responsive$/.test(f)) return true;
  return false;
}

// Verifica se campo é cor
function isColorField(field) {
  const f = field.toLowerCase();
  return /_color$|_colour$|_background_color$/.test(f) || f.includes('_bg_color') || f === 'background_color';
}

// Verifica se campo é URL de imagem
function isImageField(field) {
  const f = field.toLowerCase();
  return f.endsWith('_image') || f.endsWith('_photo') || f.endsWith('_logo') || f.endsWith('_background_image') || f === 'image';
}

// Verifica se campo é URL/link
function isLinkField(field) {
  const f = field.toLowerCase();
  return f.endsWith('_url') || f.endsWith('_link') || f === 'url' || f === 'link';
}

function isRealText(val) {
  const v = (val || '').trim();
  if (!v || v.length < 2) return false;
  const junk = new Set(['yes','no','true','false','none','auto','inherit','initial','center','left','right','top','bottom','middle','full','stretch','stacked','framed','h1','h2','h3','h4','h5','h6','classic','gradient','solid','dashed','dotted','custom','normal','bold','italic','uppercase','lowercase','image','recent','inline','block','flex','grid','absolute','relative','fixed','static','hidden','visible','fadeIn','fadeInUp','fast','slow','shrink','text_center','text_left','text_right','min-height','contain','cover','no-repeat','transform','style-1','style-2','style-3','style-4','style-5','pointer','grab','default']);
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
        if (isColorField(field) || isImageField(field) || isLinkField(field)) continue;
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
              if (isConfigField(sf) || isColorField(sf) || isImageField(sf) || isLinkField(sf)) continue;
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

// Extrai campos de cor e imagem do JSON para contexto
function extractVisualFields(data) {
  const fields = [];
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
        if (typeof val !== 'string' || !val) continue;
        const key = eid + ':' + field;
        if (seen.has(key)) continue;
        if (isColorField(field) && /^#[0-9a-fA-F]{3,8}$|^rgba?\(/.test(val)) {
          seen.add(key);
          fields.push({ elId: eid, wt, field, value: val, type: 'cor' });
        } else if (isImageField(field) && /^https?:\/\//.test(val)) {
          seen.add(key);
          fields.push({ elId: eid, wt, field, value: val, type: 'imagem' });
        } else if (isLinkField(field) && val && typeof val === 'string' && val.startsWith('http')) {
          seen.add(key);
          fields.push({ elId: eid, wt, field, value: val, type: 'link' });
        }
      }
      if (el.elements) walk(el.elements);
    }
  }
  const root = Array.isArray(data) ? data : (data.content || []);
  walk(root);
  return fields;
}

// Aplica alteração visual diretamente no JSON
function applyVisualChange(jsonData, elId, field, newValue, listKey, idx, sub) {
  const adapted = JSON.parse(JSON.stringify(jsonData));
  function w(els) {
    if (!Array.isArray(els)) return false;
    for (const el of els) {
      if (!el || typeof el !== 'object') continue;
      if (el.id === elId) {
        const s = el.settings || {};
        if (listKey && idx !== undefined && sub) {
          if (Array.isArray(s[listKey]) && s[listKey][idx]) {
            s[listKey][idx][sub] = newValue;
            return true;
          }
        } else {
          s[field] = newValue;
          return true;
        }
      }
      if (el.elements && w(el.elements)) return true;
    }
    return false;
  }
  w(Array.isArray(adapted) ? adapted : (adapted.content || []));
  return adapted;
}

function applyTexts(jsonData, texts, copies) {
  const adapted = JSON.parse(JSON.stringify(jsonData));
  function applyOne(copy, t, newText) {
    const r = Array.isArray(copy) ? copy : (copy.content || []);
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
    if (copies[i] && applyOne(adapted, texts[i], copies[i])) count++;
  }
  return { adapted, count };
}

function callClaude(system, userMsg, model, imageBase64, mediaType) {
  return new Promise((resolve, reject) => {
    const messages = [];
    if (imageBase64) {
      messages.push({
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType || 'image/png', data: imageBase64 } },
          { type: 'text', text: userMsg }
        ]
      });
    } else {
      messages.push({ role: 'user', content: userMsg });
    }
    const payload = JSON.stringify({
      model: model || 'claude-haiku-4-5-20251001',
      max_tokens: 8000,
      system,
      messages
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

function callClaudeWithPdf(system, userMsg, pdfBase64) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 8000,
      system,
      messages: [{
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
          { type: 'text', text: userMsg }
        ]
      }]
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
    req.on('end', () => {
      try { resolve(JSON.parse(body)); } catch(e) { reject(new Error('JSON inválido no body')); }
    });
  });
}

function cleanJson(str) {
  return str.replace(/```json/gi, '').replace(/```/g, '').trim();
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

  // === ROTA: ADAPTAR TEMPLATE ===
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
      const pageContext = pageTexts.length > 0 ? '\n\nTextos da pagina:\n' + pageTexts.slice(0, 30).join('\n') : '';
      const system = 'Voce adapta copy de landing pages brasileiras.\nREGRAS:\n1. APENAS lista numerada\n2. Formato: "1. texto"\n3. Respeite [X-Y palavras]\n4. Portugues brasileiro\n5. Sem explicacoes fora da lista';
      const lines = texts.map((t, i) => {
        const words = t.text.split(/\s+/).filter(w => w).length;
        return (i + 1) + '. [' + Math.max(1, Math.floor(words * 0.8)) + '-' + Math.ceil(words * 1.2) + ' palavras] ' + t.text;
      });
      const userMsg = 'EMPRESA: ' + (clientName || 'nao informado') + '\nBRIEFING:\n' + briefing + pageContext + '\n\nReescreva:\n' + lines.join('\n');
      const response = await callClaude(system, userMsg);
      const adaptedCopies = parseNumberedList(response, texts.length);
      const { adapted, count } = applyTexts(parsed, texts, adaptedCopies);
      const textMap = texts.map((t, i) => ({ original: t.text, adapted: adaptedCopies[i] || null, elId: t.elId, field: t.field || null, listKey: t.listKey || null, idx: t.idx !== undefined ? t.idx : null, sub: t.sub || null, wt: t.wt, rawHtml: t.rawHtml || false }));
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: true, total: texts.length, applied: count, json: adapted, textMap }));
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
    return;
  }

  // === ROTA: ALTERAÇÕES DO CLIENTE ===
  if (req.method === 'POST' && req.url === '/alteracoes') {
    try {
      const { alteracoesTexto, pdfBase64, imageBase64, jsonData, clientName } = await parseBody(req);
      if (!jsonData) throw new Error('JSON da pagina obrigatorio');
      if (!alteracoesTexto && !pdfBase64 && !imageBase64) throw new Error('Envie as alteracoes em texto, PDF ou imagem');

      const parsed = typeof jsonData === 'string' ? JSON.parse(jsonData) : jsonData;
      const texts = extractElementorTexts(parsed);
      const visualFields = extractVisualFields(parsed);

      // Resumo dos campos visuais para contexto da IA
      const visualSummary = visualFields.slice(0, 40).map((f, i) => {
        return '[V' + i + '] [' + f.wt + '] ' + f.field + ' = "' + f.value.substring(0, 60) + '" (tipo: ' + f.type + ')';
      }).join('\n');

      const textSummary = texts.slice(0, 60).map((t, i) => {
        return '[T' + i + '] [' + t.wt + '] "' + t.text.substring(0, 80) + '"';
      }).join('\n');

      const sys = 'Voce interpreta pedidos de alteracao de landing pages e classifica cada um.\n' +
        'Responda APENAS em JSON valido sem markdown:\n' +
        '{\n' +
        '  "alteracoes_texto": [{"indiceTexto": 0, "textoNovo": "...", "descricao": "o que muda"}],\n' +
        '  "alteracoes_cor": [{"indiceVisual": 0, "corNova": "#hex ou rgba()", "descricao": "onde fica"}],\n' +
        '  "alteracoes_imagem": [{"descricao": "qual imagem trocar e por qual", "urlAtual": "url se souber", "pendencia": "instrucao para voce fazer manualmente"}],\n' +
        '  "pendencias_manuais": [{"tipo": "cor|imagem|fonte|outro", "descricao": "o que fazer", "onde": "local na pagina", "detalhe": "valor especifico se mencionado"}]\n' +
        '}';

      const userMsg = (clientName ? 'CLIENTE: ' + clientName + '\n\n' : '') +
        'TEXTOS NA PAGINA (indices T0, T1...):\n' + textSummary +
        '\n\nCAMPOS VISUAIS (cores/imagens, indices V0, V1...):\n' + (visualSummary || '(nao encontrados)') +
        '\n\nALTERACOES SOLICITADAS:\n' + (alteracoesTexto || '[ver PDF/imagem anexo]') +
        '\n\nClassifique cada alteracao: se for texto use alteracoes_texto com indice T, se for cor use alteracoes_cor com indice V, se for imagem use alteracoes_imagem, se nao conseguir aplicar automaticamente use pendencias_manuais.';

      let r1;
      if (pdfBase64) {
        r1 = await callClaudeWithPdf(sys, userMsg, pdfBase64);
      } else if (imageBase64) {
        r1 = await callClaude(sys, userMsg, 'claude-sonnet-4-20250514', imageBase64);
      } else {
        r1 = await callClaude(sys, userMsg, 'claude-sonnet-4-20250514');
      }

      let resultado = { alteracoes_texto: [], alteracoes_cor: [], alteracoes_imagem: [], pendencias_manuais: [] };
      try { resultado = JSON.parse(cleanJson(r1)); } catch(e) {}

      // Aplicar alterações de texto
      const copies = texts.map(t => t.text);
      let textosAplicados = 0;
      (resultado.alteracoes_texto || []).forEach(alt => {
        if (alt.indiceTexto >= 0 && alt.indiceTexto < texts.length && alt.textoNovo) {
          copies[alt.indiceTexto] = alt.textoNovo;
          textosAplicados++;
        }
      });

      let { adapted, count } = applyTexts(parsed, texts, copies);

      // Aplicar alterações de cor diretamente no JSON
      let coresAplicadas = 0;
      (resultado.alteracoes_cor || []).forEach(alt => {
        const idx = alt.indiceVisual;
        if (idx >= 0 && idx < visualFields.length && alt.corNova) {
          const vf = visualFields[idx];
          // Aplicar no JSON adaptado
          function applyColorInJson(els) {
            if (!Array.isArray(els)) return;
            for (const el of els) {
              if (!el || typeof el !== 'object') continue;
              if (el.id === vf.elId && el.settings) {
                el.settings[vf.field] = alt.corNova;
                coresAplicadas++;
                return;
              }
              if (el.elements) applyColorInJson(el.elements);
            }
          }
          const root = Array.isArray(adapted) ? adapted : (adapted.content || []);
          applyColorInJson(root);
        }
      });

      // Montar pendências: imagens + o que não conseguiu aplicar
      const pendencias = [];

      (resultado.alteracoes_imagem || []).forEach(alt => {
        pendencias.push({
          tipo: 'imagem',
          descricao: alt.descricao,
          onde: alt.urlAtual ? 'URL atual: ' + alt.urlAtual : 'Ver na pagina',
          instrucao: 'Acesse o Elementor, localize a imagem e substitua manualmente.' + (alt.pendencia ? ' ' + alt.pendencia : ''),
          automatico: false
        });
      });

      (resultado.pendencias_manuais || []).forEach(p => {
        pendencias.push({
          tipo: p.tipo,
          descricao: p.descricao,
          onde: p.onde,
          instrucao: p.detalhe ? 'Valor desejado: ' + p.detalhe : 'Ajuste manualmente no Elementor.',
          automatico: false
        });
      });

      const totalAplicado = textosAplicados + coresAplicadas;

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        success: true,
        totalAlteracoes: (resultado.alteracoes_texto || []).length + (resultado.alteracoes_cor || []).length + (resultado.alteracoes_imagem || []).length + (resultado.pendencias_manuais || []).length,
        aplicadosAutomatico: totalAplicado,
        textosAplicados,
        coresAplicadas,
        pendencias,
        json: adapted
      }));
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
    return;
  }

  // === ROTA: CORRIGIR ERROS ===
  if (req.method === 'POST' && req.url === '/fix') {
    try {
      const { errorDescription, briefing, clientName, textMap, jsonData, imageBase64 } = await parseBody(req);
      if (!briefing) throw new Error('Briefing obrigatorio');
      let descFinal = errorDescription || '';
      if (imageBase64 && !descFinal) {
        const sysImg = 'Voce analisa prints de landing pages e identifica erros de copy. Liste em portugues os textos errados.';
        descFinal = await callClaude(sysImg, 'Analise este print e liste o que esta errado (textos em ingles, lorem ipsum, fora do contexto).', 'claude-sonnet-4-20250514', imageBase64);
      }
      if (!descFinal) throw new Error('Descricao do erro obrigatoria');
      const system = 'Voce corrige erros de copy em landing pages. Responda em JSON: {"fixes":[{"original":"texto errado","corrected":"texto correto","reason":"motivo"}],"newTexts":[{"description":"campo","text":"texto"}]}';
      const textSample = textMap ? textMap.slice(0, 30).map((t, i) => (i + 1) + '. [' + t.wt + '] "' + t.original + '" -> "' + (t.adapted || 'NAO ADAPTADO') + '"').join('\n') : '';
      const userMsg = 'EMPRESA: ' + (clientName || 'nao informado') + '\nBRIEFING: ' + briefing + '\n\nPROBLEMA:\n' + descFinal + (textSample ? '\n\nTEXTOS:\n' + textSample : '') + '\n\nGere as correcoes em JSON.';
      const response = await callClaude(system, userMsg, 'claude-sonnet-4-20250514', imageBase64 || null);
      let fixes = { fixes: [], newTexts: [] };
      try { fixes = JSON.parse(cleanJson(response)); } catch(e) {}
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
