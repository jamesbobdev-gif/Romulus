// A model's answer in markdown (headings, **bold**, lists, links, tables), drawn as real text.
// Builds DOM nodes only: the model's words never go through innerHTML. Links open in the browser.
function looksLikeMd(s){ return /(^|\n)\s{0,3}(#{1,6}\s|[-*]\s|\d+[.)]\s|\|.*\|)|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\(https?:\/\/[^)\s]+\)/.test(String(s||'')); }

function mdInline(text){
  const frag=document.createDocumentFragment();
  const re=/\*\*([^*\n]+)\*\*|__([^_\n]+)__|`([^`\n]+)`|\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])|\*([^*\n]+)\*|(?:^|(?<=\s))_([^_\n]+)_(?=\s|$|[.,;:!?])/g;
  let last=0, m;
  while((m=re.exec(text))){
    if(m.index>last)frag.appendChild(document.createTextNode(text.slice(last,m.index)));
    if(m[1]||m[2])frag.appendChild(el('strong',null,m[1]||m[2]));
    else if(m[3])frag.appendChild(el('code',null,m[3]));
    else if(m[4]||m[6]){
      const url=m[5]||m[6];
      const a=el('a','md-link',m[4]||url.replace(/^https?:\/\/(www\.)?/,'').replace(/[?#].*$/,'').slice(0,60));
      a.href=url; a.title=url;
      a.addEventListener('click',function(e){ e.preventDefault(); e.stopPropagation(); openExternal(url); });
      frag.appendChild(a);
    }
    else frag.appendChild(el('em',null,m[7]||m[8]));
    last=re.lastIndex;
  }
  if(last<text.length)frag.appendChild(document.createTextNode(text.slice(last)));
  return frag;
}

function mdBlock(text){
  const box=el('div','md');
  const lines=String(text||'').replace(/\r\n?/g,'\n').split('\n');
  let list=null, para=null;
  const end=function(){ list=null; para=null; };
  const cells=function(row){ return row.trim().replace(/^\||\|$/g,'').split('|').map(function(c){ return c.trim(); }); };
  for(let i=0;i<lines.length;i++){
    const line=lines[i];
    if(!line.trim()){ end(); continue; }
    let m;
    if((m=/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line))){
      end(); const h=el('div','md-h md-h'+Math.min(m[1].length,3)); h.appendChild(mdInline(m[2])); box.appendChild(h); continue;
    }
    if(/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)){ end(); box.appendChild(el('hr','md-hr')); continue; }
    // a table: a header row, then |---|---|
    if(/\|/.test(line)&&i+1<lines.length&&/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i+1])){
      end();
      const wrap=el('div','md-table'), tb=el('table');
      const hr=el('tr'); cells(line).forEach(function(c){ const th=el('th'); th.appendChild(mdInline(c)); hr.appendChild(th); }); tb.appendChild(hr);
      i+=2;
      for(;i<lines.length&&/\|/.test(lines[i])&&lines[i].trim();i++){
        const tr=el('tr'); cells(lines[i]).forEach(function(c){ const td=el('td'); td.appendChild(mdInline(c)); tr.appendChild(td); }); tb.appendChild(tr);
      }
      i--;
      wrap.appendChild(tb); box.appendChild(wrap); continue;
    }
    if((m=/^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(line))){
      para=null;
      const tag=/\d/.test(m[1])?'ol':'ul';
      if(!list||list.tagName.toLowerCase()!==tag){ list=el(tag,'md-list'); box.appendChild(list); }
      const li=el('li'); li.appendChild(mdInline(m[2])); list.appendChild(li); continue;
    }
    if((m=/^\s*>\s?(.*)$/.exec(line))){ end(); const q=el('div','md-quote'); q.appendChild(mdInline(m[1])); box.appendChild(q); continue; }
    // a wrapped line under a list item belongs to it
    if(list&&/^\s{2,}\S/.test(line)){ const li=list.lastChild; li.appendChild(document.createTextNode(' ')); li.appendChild(mdInline(line.trim())); continue; }
    list=null;
    if(para){ para.appendChild(el('br')); para.appendChild(mdInline(line)); }
    else{ para=el('p'); para.appendChild(mdInline(line)); box.appendChild(para); }
  }
  return box;
}

// markdown when it looks like markdown; plain text otherwise (keeps its line breaks)
function richText(text){ return looksLikeMd(text)?mdBlock(text):document.createTextNode(String(text||'')); }
