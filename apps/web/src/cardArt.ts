// @ts-nocheck
/* Classic card faces drawn as SVG strings. Shared by all the card games. */
export const CardArt: { face(card: number): string; suitSvg(suit: number): string; RL(rank: number): string } = (function(){
  const RED='#c8102e', BLK='#151515', BLUE='#1d3f8f', GOLD='#e9b52f', SKIN='#f7dfc0';
  const PATHS=[
    // spade
    'M50 2C50 2 3 40 3 63C3 79 15 89 29 89C38 89 45 85 48 78C46 89 40 95 30 98L70 98C60 95 54 89 52 78C55 85 62 89 71 89C85 89 97 79 97 63C97 40 50 2 50 2Z',
    // heart
    'M50 92C20 68 3 50 3 30C3 14 15 3 29 3C39 3 46 9 50 18C54 9 61 3 71 3C85 3 97 14 97 30C97 50 80 68 50 92Z',
    // diamond
    'M50 2L88 50L50 98L12 50Z',
    // club
    'M50 4A21 21 0 0 1 69 35A21 21 0 1 1 55 72C57 85 62 93 70 98L30 98C38 93 43 85 45 72A21 21 0 1 1 31 35A21 21 0 0 1 50 4Z'
  ];
  const colorOf=s=>(s===1||s===2)?RED:BLK;
  const RL=r=>r<=10?String(r):['J','Q','K','A'][r-11];
  function pip(s,cx,cy,size,rot){
    const k=size/100;
    return `<path d="${PATHS[s]}" transform="translate(${cx} ${cy})${rot?' rotate(180)':''} scale(${k}) translate(-50 -50)"/>`;
  }
  const L=66,M=120,R=174;
  const LAYOUT={
    2:[[M,64],[M,272]],
    3:[[M,64],[M,168],[M,272]],
    4:[[L,64],[R,64],[L,272],[R,272]],
    5:[[L,64],[R,64],[M,168],[L,272],[R,272]],
    6:[[L,64],[R,64],[L,168],[R,168],[L,272],[R,272]],
    7:[[L,64],[R,64],[M,116],[L,168],[R,168],[L,272],[R,272]],
    8:[[L,64],[R,64],[M,116],[L,168],[R,168],[M,220],[L,272],[R,272]],
    9:[[L,64],[R,64],[L,133],[R,133],[M,168],[L,203],[R,203],[L,272],[R,272]],
    10:[[L,64],[R,64],[M,99],[L,133],[R,133],[L,203],[R,203],[M,237],[L,272],[R,272]]
  };
  function corner(s,r){
    const t=RL(r);
    const fs=t==='10'?34:40;
    return `<text x="23" y="44" text-anchor="middle" font-size="${fs}" ${t==='10'?'letter-spacing="-3"':''} font-family="Georgia, 'Times New Roman', Times, serif" font-weight="700">${t}</text>`+pip(s,23,66,26,false);
  }
  // one half of a court figure, drawn upright in the top half (y 34..168), mirrored for the bottom half
  function courtHalf(s,r){
    const main=(s===1||s===2)?RED:BLUE, alt=(s===1||s===2)?BLUE:RED;
    const ink=BLK;
    let g='';
    // robe / shoulders
    g+=`<path d="M58 168 L62 120 Q70 104 96 100 L144 100 Q170 104 178 120 L182 168 Z" fill="${main}" stroke="${ink}" stroke-width="2"/>`;
    g+=`<path d="M96 100 L120 140 L144 100 Z" fill="${GOLD}" stroke="${ink}" stroke-width="2"/>`;
    g+=`<path d="M62 132 L100 132 L104 168 L60 168 Z" fill="${alt}" stroke="${ink}" stroke-width="2"/>`;
    g+=`<path d="M140 132 L178 132 L180 168 L136 168 Z" fill="${GOLD}" stroke="${ink}" stroke-width="2"/>`;
    for(let i=0;i<4;i++)g+=`<circle cx="${70+i*9}" cy="150" r="3" fill="${GOLD}" stroke="${ink}" stroke-width="1"/>`;
    for(let i=0;i<4;i++)g+=`<path d="M${144+i*9} 140 l4 8 l-4 8 l-4 -8z" fill="${main}" stroke="${ink}" stroke-width="1"/>`;
    g+=`<path d="M104 140 L136 140 L136 168 L104 168 Z" fill="#fff" stroke="${ink}" stroke-width="2"/>`;
    g+=`<path d="M108 146 h24 M108 154 h24 M108 162 h24" stroke="${main}" stroke-width="3"/>`;
    // hair
    const hair=r===12?GOLD:r===13?'#f3e2a2':'#5b3a1e';
    if(r===12)g+=`<path d="M96 74 Q92 104 102 112 L138 112 Q148 104 144 74 Z" fill="${hair}" stroke="${ink}" stroke-width="2"/>`;
    // face
    g+=`<ellipse cx="120" cy="82" rx="17" ry="20" fill="${SKIN}" stroke="${ink}" stroke-width="2"/>`;
    g+=`<path d="M111 80 q3 -3 6 0 M123 80 q3 -3 6 0" stroke="${ink}" stroke-width="2" fill="none"/>`;
    g+=`<path d="M120 82 l-3 8 h4" stroke="${ink}" stroke-width="1.5" fill="none"/>`;
    if(r===13){ // beard + moustache
      g+=`<path d="M104 88 Q106 116 120 120 Q134 116 136 88 Q128 98 120 96 Q112 98 104 88Z" fill="#f3e2a2" stroke="${ink}" stroke-width="2"/>`;
      g+=`<path d="M110 94 q10 -6 20 0" stroke="${ink}" stroke-width="2" fill="none"/>`;
    }else{
      g+=`<path d="M114 94 q6 4 12 0" stroke="${RED}" stroke-width="2.5" fill="none"/>`;
    }
    // headwear
    if(r===13){
      g+=`<path d="M98 66 L100 40 L109 54 L120 34 L131 54 L140 40 L142 66 Z" fill="${GOLD}" stroke="${ink}" stroke-width="2"/>`;
      g+=`<rect x="98" y="60" width="44" height="8" fill="${alt}" stroke="${ink}" stroke-width="2"/>`;
      g+=`<circle cx="120" cy="44" r="3.5" fill="${RED}" stroke="${ink}" stroke-width="1"/>`;
    }else if(r===12){
      g+=`<path d="M100 66 Q100 50 106 46 L112 56 L120 42 L128 56 L134 46 Q140 50 140 66 Z" fill="${GOLD}" stroke="${ink}" stroke-width="2"/>`;
      g+=`<path d="M100 64 h40" stroke="${main}" stroke-width="4"/>`;
    }else{
      g+=`<path d="M98 68 Q100 46 120 46 Q140 46 142 68 Z" fill="${main}" stroke="${ink}" stroke-width="2"/>`;
      g+=`<path d="M96 68 h48" stroke="${ink}" stroke-width="3"/>`;
      g+=`<path d="M138 50 Q158 30 150 58" fill="${GOLD}" stroke="${ink}" stroke-width="2"/>`;
      g+=`<path d="M100 70 Q96 84 100 92 M140 70 Q144 84 140 92" stroke="#5b3a1e" stroke-width="5" fill="none"/>`;
    }
    // held item on the left side
    if(r===13)g+=`<path d="M74 166 L74 104 M66 112 h16" stroke="${ink}" stroke-width="4"/><path d="M74 104 l-3 -16 l3 -6 l3 6z" fill="#cfd6dd" stroke="${ink}" stroke-width="1.5"/>`;
    else if(r===12)g+=`<path d="M76 166 Q74 130 78 108" stroke="#2e7d32" stroke-width="3" fill="none"/><circle cx="78" cy="102" r="7" fill="${RED}" stroke="${ink}" stroke-width="1.5"/><circle cx="78" cy="102" r="2.5" fill="${GOLD}"/>`;
    else g+=`<path d="M72 166 L72 92" stroke="#7a4b22" stroke-width="4"/><path d="M72 92 q-10 -6 -4 -18 q4 8 4 18 q0 -10 4 -18 q6 12 -4 18z" fill="${GOLD}" stroke="${ink}" stroke-width="1.5"/>`;
    return g;
  }
  function face(c){
    const s=(c/13)|0, r=c%13+2, col=colorOf(s);
    let body='';
    if(r<=10){
      body=`<g fill="${col}">`+LAYOUT[r].map(([x,y])=>pip(s,x,y,46,y>168)).join('')+'</g>';
    }else if(r===14){
      if(s===0){
        body=`<g fill="${BLK}">${pip(0,120,164,128,false)}</g>`+
          `<circle cx="120" cy="164" r="78" fill="none" stroke="${BLK}" stroke-width="1.5"/>`+
          `<circle cx="120" cy="164" r="72" fill="none" stroke="${BLK}" stroke-width="0.8" stroke-dasharray="3 4"/>`+
          `<path d="M120 112 q-10 18 0 34 q10 -16 0 -34z" fill="#fff" opacity=".85"/>`;
      }else body=`<g fill="${col}">${pip(s,120,168,78,false)}</g>`;
    }else{
      const half=courtHalf(s,r);
      body=`<rect x="44" y="34" width="152" height="268" fill="#fff" stroke="${col}" stroke-width="2"/>`+
        `<clipPath id="cl"><rect x="45" y="35" width="150" height="266"/></clipPath>`+
        `<g clip-path="url(#cl)">${half}<g transform="rotate(180 120 168)">${half}</g></g>`+
        `<path d="M44 168 H196" stroke="${BLK}" stroke-width="1.5"/>`+
        `<rect x="44" y="34" width="152" height="268" fill="none" stroke="${BLK}" stroke-width="2.5"/>`+
        `<g fill="${col}">${pip(s,62,54,20,false)}${pip(s,178,282,20,true)}</g>`;
    }
    return `<svg viewBox="0 0 240 336" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">`+
      `<rect x="1.5" y="1.5" width="237" height="333" rx="15" fill="#fff" stroke="#b9b6ae" stroke-width="2"/>`+
      body+
      `<g fill="${col}">${corner(s,r)}<g transform="rotate(180 120 168)">${corner(s,r)}</g></g></svg>`;
  }
  const cache={};
  const suitSvg=s=>`<svg viewBox="0 0 100 100" aria-hidden="true" focusable="false"><path d="${PATHS[s]}" fill="${colorOf(s)}"/></svg>`;
  return {face:c=>cache[c]||(cache[c]=face(c)), RL, suitSvg};
})();
