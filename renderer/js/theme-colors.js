/* Custom CSS colours: every unique colour in pasted CSS, each given a plain colour name (Blue, Dark gray...),
   and each distinct CSS kept in a saved list named after its main colour (settings.js draws both).
   One of the page scripts in renderer/js: they share one global scope and load in the order index.html lists them.
   Also loaded by test/theme-colors.test.js, so nothing here touches the page. */
'use strict';

const THEME_SAVED_KEY='tasks.themes.v1';
const THEME_SAVED_MAX=20;

function themeHex2(n){ return Math.max(0,Math.min(255,Math.round(n))).toString(16).padStart(2,'0').toUpperCase(); }
function themeHslToRgb(h,s,l){
  h=((h%360)+360)%360; s=Math.max(0,Math.min(1,s)); l=Math.max(0,Math.min(1,l));
  const c=(1-Math.abs(2*l-1))*s, x=c*(1-Math.abs((h/60)%2-1)), m=l-c/2;
  const r=h<60?[c,x,0]:h<120?[x,c,0]:h<180?[0,c,x]:h<240?[0,x,c]:h<300?[x,0,c]:[c,0,x];
  return r.map(function(v){ return (v+m)*255; });
}
// the CSS colour words (red, navy, rebeccapurple...) and what they stand for
const THEME_NAMED={};
('aliceblue:F0F8FF antiquewhite:FAEBD7 aqua:00FFFF aquamarine:7FFFD4 azure:F0FFFF beige:F5F5DC bisque:FFE4C4 black:000000 '+
'blanchedalmond:FFEBCD blue:0000FF blueviolet:8A2BE2 brown:A52A2A burlywood:DEB887 cadetblue:5F9EA0 chartreuse:7FFF00 '+
'chocolate:D2691E coral:FF7F50 cornflowerblue:6495ED cornsilk:FFF8DC crimson:DC143C cyan:00FFFF darkblue:00008B darkcyan:008B8B '+
'darkgoldenrod:B8860B darkgray:A9A9A9 darkgreen:006400 darkgrey:A9A9A9 darkkhaki:BDB76B darkmagenta:8B008B darkolivegreen:556B2F '+
'darkorange:FF8C00 darkorchid:9932CC darkred:8B0000 darksalmon:E9967A darkseagreen:8FBC8F darkslateblue:483D8B darkslategray:2F4F4F '+
'darkslategrey:2F4F4F darkturquoise:00CED1 darkviolet:9400D3 deeppink:FF1493 deepskyblue:00BFFF dimgray:696969 dimgrey:696969 '+
'dodgerblue:1E90FF firebrick:B22222 floralwhite:FFFAF0 forestgreen:228B22 fuchsia:FF00FF gainsboro:DCDCDC ghostwhite:F8F8FF '+
'gold:FFD700 goldenrod:DAA520 gray:808080 green:008000 greenyellow:ADFF2F grey:808080 honeydew:F0FFF0 hotpink:FF69B4 '+
'indianred:CD5C5C indigo:4B0082 ivory:FFFFF0 khaki:F0E68C lavender:E6E6FA lavenderblush:FFF0F5 lawngreen:7CFC00 lemonchiffon:FFFACD '+
'lightblue:ADD8E6 lightcoral:F08080 lightcyan:E0FFFF lightgoldenrodyellow:FAFAD2 lightgray:D3D3D3 lightgreen:90EE90 lightgrey:D3D3D3 '+
'lightpink:FFB6C1 lightsalmon:FFA07A lightseagreen:20B2AA lightskyblue:87CEFA lightslategray:778899 lightslategrey:778899 '+
'lightsteelblue:B0C4DE lightyellow:FFFFE0 lime:00FF00 limegreen:32CD32 linen:FAF0E6 magenta:FF00FF maroon:800000 '+
'mediumaquamarine:66CDAA mediumblue:0000CD mediumorchid:BA55D3 mediumpurple:9370DB mediumseagreen:3CB371 mediumslateblue:7B68EE '+
'mediumspringgreen:00FA9A mediumturquoise:48D1CC mediumvioletred:C71585 midnightblue:191970 mintcream:F5FFFA mistyrose:FFE4E1 '+
'moccasin:FFE4B5 navajowhite:FFDEAD navy:000080 oldlace:FDF5E6 olive:808000 olivedrab:6B8E23 orange:FFA500 orangered:FF4500 '+
'orchid:DA70D6 palegoldenrod:EEE8AA palegreen:98FB98 paleturquoise:AFEEEE palevioletred:DB7093 papayawhip:FFEFD5 peachpuff:FFDAB9 '+
'peru:CD853F pink:FFC0CB plum:DDA0DD powderblue:B0E0E6 purple:800080 rebeccapurple:663399 red:FF0000 rosybrown:BC8F8F '+
'royalblue:4169E1 saddlebrown:8B4513 salmon:FA8072 sandybrown:F4A460 seagreen:2E8B57 seashell:FFF5EE sienna:A0522D silver:C0C0C0 '+
'skyblue:87CEEB slateblue:6A5ACD slategray:708090 slategrey:708090 snow:FFFAFA springgreen:00FF7F steelblue:4682B4 tan:D2B48C '+
'teal:008080 thistle:D8BFD8 tomato:FF6347 turquoise:40E0D0 violet:EE82EE wheat:F5DEB3 white:FFFFFF whitesmoke:F5F5F5 '+
'yellow:FFFF00 yellowgreen:9ACD32').split(' ').forEach(function(p){ const kv=p.split(':'); THEME_NAMED[kv[0]]='#'+kv[1]; });

// one colour as written in CSS → '#RRGGBB' (alpha dropped: the name is about the colour, not how see-through it is)
function themeColorHex(s){
  s=String(s).trim();
  if(THEME_NAMED[s.toLowerCase()])return THEME_NAMED[s.toLowerCase()];
  let m=s.match(/^#([0-9a-f]{3,8})$/i);
  if(m){
    let h=m[1];
    if(h.length===3||h.length===4)h=h.slice(0,3).split('').map(function(c){ return c+c; }).join('');
    else if(h.length===8)h=h.slice(0,6);
    else if(h.length!==6)return null;
    return '#'+h.toUpperCase();
  }
  m=s.match(/^rgba?\(\s*([\d.]+%?)[\s,]+([\d.]+%?)[\s,]+([\d.]+%?)/i);
  if(m)return '#'+m.slice(1,4).map(function(v){ return themeHex2(v.endsWith('%')?parseFloat(v)*2.55:parseFloat(v)); }).join('');
  m=s.match(/^hsla?\(\s*(-?[\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%/i);
  if(m)return '#'+themeHslToRgb(+m[1],m[2]/100,m[3]/100).map(themeHex2).join('');
  return null;
}
function themeHexHsl(hex){
  const r=parseInt(hex.slice(1,3),16)/255, g=parseInt(hex.slice(3,5),16)/255, b=parseInt(hex.slice(5,7),16)/255;
  const max=Math.max(r,g,b), min=Math.min(r,g,b), l=(max+min)/2, d=max-min;
  if(!d)return {h:0,s:0,l:l};
  const s=d/(1-Math.abs(2*l-1));
  let h=max===r?((g-b)/d)%6:max===g?(b-r)/d+2:(r-g)/d+4;
  h*=60; if(h<0)h+=360;
  return {h:h,s:s,l:l};
}
// '#2742C8' → 'Blue', '#161616' → 'Black', '#71716C' → 'Gray', '#3A2E12' → 'Brown'
function themeColorName(hex){
  const c=themeHexHsl(hex);
  if(c.l<=.1)return 'Black';
  if(c.l>=.95)return 'White';
  if(c.s<.15||(c.s<.25&&(c.l<.2||c.l>.9))){ return c.l<.3?'Dark gray':c.l>.8?'Light gray':'Gray'; }
  const h=c.h;
  let base=h<15||h>=345?'Red':h<45?'Orange':h<65?'Yellow':h<160?'Green':h<195?'Teal':h<255?'Blue':h<290?'Purple':'Pink';
  if((base==='Orange'||base==='Red'||base==='Yellow')&&c.l<.4&&h>=10&&h<55)base='Brown';
  return c.l<.3&&base!=='Brown'?'Dark '+base.toLowerCase():c.l>.8?'Light '+base.toLowerCase():base;
}
// every unique colour in the CSS, in the order it first appears, with the property or --variable it's set on
function themeCssColors(css){
  const out=[], seen={};
  const src=String(css||'').replace(/\/\*[\s\S]*?\*\//g,' ');
  const re=/([\w-]+)\s*:\s*([^;{}]*)/g;
  // colour words only as whole words, so --red, red-ish and redwood aren't colours
  const col=new RegExp('#[0-9a-f]{3,8}\\b|(?:rgba?|hsla?)\\([^)]*\\)|(?<![\\w-])(?:'+Object.keys(THEME_NAMED).join('|')+')(?![\\w-])','gi');
  const notColour=/^(?:font|font-family|content|animation|animation-name|transition|transition-property|grid-area|grid-template-areas|counter-reset|counter-increment|list-style-type|quotes)$/i;
  let d;
  while((d=re.exec(src))){
    if(notColour.test(d[1]))continue; // 'Georgia, tan' or content:"red" are words, not colours
    // var(--red), url(red.png) and quoted text aren't colours either
    const val=d[2].replace(/"[^"]*"|'[^']*'/g,' ').replace(/(?:var|url)\([^)]*\)/gi,' ');
    const vals=val.match(col)||[];
    vals.forEach(function(v){
      const hex=themeColorHex(v); if(!hex)return;
      if(seen[hex]){ if(seen[hex].used.indexOf(d[1])<0)seen[hex].used.push(d[1]); return; }
      seen[hex]={hex:hex,name:themeColorName(hex),used:[d[1]]};
      out.push(seen[hex]);
    });
  }
  return out;
}
// the colour a theme is known by: its --accent, else the first colour that isn't black/white/gray, else the first one
function themeMainColor(colors){
  const neutral=/gray|black|white/i;
  return colors.find(function(c){ return c.used.indexOf('--accent')>=0; })
    ||colors.find(function(c){ return !neutral.test(c.name); })
    ||colors[0]||null;
}
// add pasted CSS to the saved list; the same CSS again (ignoring spacing) just moves to the top.
// label: the name you gave it. Saving under a name you already have replaces that one's CSS;
// the same CSS under a new name renames it. No label: named after its main colour.
function themeSaveCss(list,css,now,label){
  list=Array.isArray(list)?list.slice():[];
  const key=String(css||'').replace(/\s+/g,'');
  if(!key)return list;
  label=String(label||'').trim().slice(0,40);
  const colors=themeCssColors(css), main=themeMainColor(colors);
  const same=list.findIndex(function(t){ return String(t.css).replace(/\s+/g,'')===key; });
  let old=label?list.findIndex(function(t){ return t.name===label; }):-1;
  if(old<0)old=same;
  else if(same>=0&&same!==old){ list.splice(same,1); if(same<old)old--; } // that CSS now lives under the label
  if(old>=0){
    const t=list.splice(old,1)[0];
    t.css=css; t.colors=colors; t.hex=main?main.hex:''; t.at=now; if(label)t.name=label;
    list.unshift(t); return list;
  }
  const base=label||(main?main.name:'No colour');
  let name=base, n=2;
  while(list.some(function(t){ return t.name===name; }))name=base+' '+(n++);
  list.unshift({name:name,hex:main?main.hex:'',css:css,colors:colors,at:now});
  return list.slice(0,THEME_SAVED_MAX);
}

if(typeof module!=='undefined'&&module.exports){ module.exports={themeColorHex:themeColorHex,themeColorName:themeColorName,themeCssColors:themeCssColors,themeMainColor:themeMainColor,themeSaveCss:themeSaveCss}; }
