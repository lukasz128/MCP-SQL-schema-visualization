// The one inline <script> of the page: drag tables by their header, edges follow.
// The static SVG is complete without it; the script only moves what is already drawn.
//
// Markup it relies on (written by render.ts):
//   <g data-t="n3" transform="translate(x,y)">   one per node, children in local coordinates,
//                                                 first <rect> = the node's full box
//   <path data-from="n3" data-fr="2" data-to="n0" data-tr="0">   one per edge (node ids + row indexes, -1 = header)
//   <button id="reset" hidden>                    shown by the script
//
// Anchors use the same constants and formula as layout.ts (rowCenterY, side facing the other node),
// injected here so the two cannot drift apart.
import { HEADER_HEIGHT, LOOP_OFFSET, MARGIN, ROW_HEIGHT } from "./layout.js";

const SOURCE = `(()=>{
const H=${HEADER_HEIGHT},R=${ROW_HEIGHT},O=${LOOP_OFFSET},M=${MARGIN};
const svg=document.querySelector("main svg");
if(!svg||!svg.getScreenCTM||!window.DOMPoint)return;
const f=v=>Math.round(v*10)/10;
const vb0=svg.getAttribute("viewBox").split(" ").map(Number),w0=svg.getAttribute("width"),h0=svg.getAttribute("height");
const nodes={},order=[],edges=[...svg.querySelectorAll("path[data-from]")];
for(const g of svg.querySelectorAll("g[data-t]")){
const m=/translate\\(([-\\d.]+),([-\\d.]+)\\)/.exec(g.getAttribute("transform")),r=g.querySelector("rect");
const n={g,x:+m[1],y:+m[2],x0:+m[1],y0:+m[2],w:r.width.baseVal.value,h:r.height.baseVal.value,e:[]};
nodes[g.dataset.t]=n;order.push(n);
}
for(const e of edges){
e.d0=e.getAttribute("d");
const a=nodes[e.dataset.from],b=nodes[e.dataset.to];
if(!a||!b)continue;
a.e.push(e);if(b!==a)b.e.push(e);
}
const moved=n=>n.x!==n.x0||n.y!==n.y0;
const rowY=(n,r)=>n.y+(r<0?H/2:H+r*R+R/2);
const draw=e=>{
const a=nodes[e.dataset.from],b=nodes[e.dataset.to];
if(a===b){e.setAttribute("transform","translate("+f(a.x-a.x0)+","+f(a.y-a.y0)+")");return;}
if(!moved(a)&&!moved(b)){e.setAttribute("d",e.d0);return;}
const y1=f(rowY(a,+e.dataset.fr)),y2=f(rowY(b,+e.dataset.tr)),ac=a.x+a.w/2,bc=b.x+b.w/2;
let d;
if(Math.abs(ac-bc)<(a.w+b.w)/2){
const x1=f(a.x+a.w),x2=f(b.x+b.w),c=f(Math.max(x1,x2)+O*1.5);
d="M"+x1+","+y1+"C"+c+","+y1+" "+c+","+y2+" "+x2+","+y2;
}else{
const s=bc>ac?1:-1,x1=f(s>0?a.x+a.w:a.x),x2=f(s>0?b.x:b.x+b.w),k=f(s*Math.max(Math.abs(x2-x1)/2,O));
d="M"+x1+","+y1+"C"+f(x1+k)+","+y1+" "+f(x2-k)+","+y2+" "+x2+","+y2;
}
e.setAttribute("d",d);
};
const fit=()=>{
const b=svg.getBBox(),x=Math.min(vb0[0],f(b.x-M)),y=Math.min(vb0[1],f(b.y-M));
const w=f(Math.max(vb0[0]+vb0[2],b.x+b.width+M)-x),h=f(Math.max(vb0[1]+vb0[3],b.y+b.height+M)-y);
svg.setAttribute("viewBox",x+" "+y+" "+w+" "+h);svg.setAttribute("width",w);svg.setAttribute("height",h);
};
const pt=e=>new DOMPoint(e.clientX,e.clientY).matrixTransform(svg.getScreenCTM().inverse());
let cur=null;
svg.addEventListener("pointerdown",e=>{
if(cur||!e.isPrimary||e.button!==0)return;
const g=e.target.closest&&e.target.closest("g[data-t]"),n=g&&nodes[g.dataset.t];
if(!n)return;
const p=pt(e);
if(p.y-n.y>H)return;
e.preventDefault();
g.parentNode.appendChild(g);
cur={n,id:e.pointerId,dx:p.x-n.x,dy:p.y-n.y};
svg.setPointerCapture(e.pointerId);svg.classList.add("dg");
});
svg.addEventListener("pointermove",e=>{
if(!cur||e.pointerId!==cur.id)return;
const p=pt(e),n=cur.n;
n.x=f(p.x-cur.dx);n.y=f(p.y-cur.dy);
n.g.setAttribute("transform","translate("+n.x+","+n.y+")");
n.e.forEach(draw);
});
const end=e=>{
if(!cur||e.pointerId!==cur.id)return;
cur=null;svg.classList.remove("dg");fit();
};
svg.addEventListener("pointerup",end);svg.addEventListener("pointercancel",end);
const btn=document.getElementById("reset");
if(btn){btn.hidden=false;btn.addEventListener("click",()=>{
for(const n of order){n.x=n.x0;n.y=n.y0;n.g.setAttribute("transform","translate("+n.x+","+n.y+")");n.g.parentNode.appendChild(n.g);}
for(const e of edges){e.setAttribute("d",e.d0);e.removeAttribute("transform");}
svg.setAttribute("viewBox",vb0.join(" "));svg.setAttribute("width",w0);svg.setAttribute("height",h0);
});}
svg.classList.add("dr");
})();`;

/** The page's inline script, one statement per line, constants already filled in. */
export function dragScript(): string {
  return SOURCE;
}
