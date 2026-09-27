// Example catalog for a first look.
import { store } from '../../../shared/state/store.js';
import { pushLocalToSupabase } from '../../sync/services/pull.js';
import { saveCatalog, saveMoves } from '../../../shared/state/persistence.js';
import { renderAll } from '../../../shared/ui/render.js';
import { COLORS } from '../../../shared/utils/colors.js';

/* ================= products ================= */

export function exampleCatalog(){
  const mk=(id,name,cat,price,cost,colors,sizes,stock,color)=>{
    const variants=[],opts=[...(colors.length?[{n:"Colour",v:colors}]:[]),...(sizes.length?[{n:"Size",v:sizes}]:[])];
    (colors.length?colors:[""]).forEach((c,ci)=>(sizes.length?sizes:[""]).forEach((s,si)=>variants.push({id:id+":"+(c?c+"-":"")+s,o:[c,s].filter(Boolean),sku:"",bc:"",price:null,cost:null,active:true,q:(stock[ci]||[])[si]||0})));
    return {p:{id,name,cat,brand:"",desc:"",price,cost,color,archived:false,hsn:"",gst:null,code:"",opts,variants}};
  };
  const S5=["S","M","L","XL","XXL"],W=["28","30","32","34","36"];
  const list=[
    mk("p1","Oversized Tee","T-shirts",599,320,["Black","White","Navy"],S5,[[7,10,3,8,4],[5,9,10,6,2],[3,7,8,4,1]],COLORS[0]),
    mk("p3","Graphic Tee","T-shirts",699,360,["Black","White"],S5,[[6,8,8,5,3],[4,6,7,4,2]],COLORS[2]),
    mk("p4","Polo T-shirt","T-shirts",799,430,["Navy","Maroon","White"],["S","M","L","XL"],[[5,6,6,3],[4,5,5,2],[5,5,4,3]],COLORS[3]),
    mk("p5","Linen Shirt","Shirts",1199,650,["Beige","Blue"],["M","L","XL"],[[6,6,4],[5,5,3]],COLORS[4]),
    mk("p6","Denim Jacket","Jackets",1899,1100,[],["S","M","L","XL"],[[4,6,5,3]],COLORS[5]),
    mk("p7","Hoodie","Sweatshirts",1299,700,["Black","Grey"],S5,[[4,6,6,4,2],[3,5,5,3,2]],COLORS[6]),
    mk("p8","Cargo Pants","Bottoms",1099,590,["Olive","Black"],W,[[3,5,6,5,3],[4,6,6,4,2]],COLORS[7]),
    mk("p9","Joggers","Bottoms",899,470,["Grey","Black"],["S","M","L","XL"],[[5,7,7,4],[5,6,6,4]],COLORS[8]),
    mk("p10","Kurta","Ethnic",999,520,["White","Maroon"],["M","L","XL","XXL"],[[4,6,5,3],[3,5,4,2]],COLORS[9]),
    mk("p11","Tote Bag","Accessories",399,180,[],[],[[12]],COLORS[10])
  ];
  const t=Date.now(),mv={};
  list.forEach(({p})=>p.variants.forEach(v=>{const q=v.q;delete v.q;if(q){const id="open:"+v.id;mv[id]={id,v:v.id,p:p.id,type:"OPENING",q,cost:null,note:"Example opening stock",t,dev:store.dev}}}));
  return {cat:{version:3,example:true,products:list.map(x=>x.p)},moves:mv};
}
export function loadExamples(){
  const ex=exampleCatalog();
  store.catalog=ex.cat;Object.assign(store.moves,ex.moves);saveCatalog();saveMoves();
  renderAll();
  if(store.authUser)pushLocalToSupabase();
}
