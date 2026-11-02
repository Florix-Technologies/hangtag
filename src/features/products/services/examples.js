// Example catalog for a first look.
import { store } from '../../../shared/state/store.js';
import { pushLocalToSupabase } from '../../sync/services/pull.js';
import { saveCatalog, saveMoves } from '../../../shared/state/persistence.js';
import { renderAll } from '../../../shared/ui/render.js';
import { COLORS } from '../../../shared/utils/colors.js';
import { refuse } from '../../shop/services/access.js';
import { shopType } from '../../shop/services/shop-caps.js';

/* ================= products ================= */

/* Example products that fit the kind of shop (a clothing store's for retail) */
export function exampleCatalog(type){
  const mk=(id,name,cat,price,cost,colors,sizes,stock,color)=>{
    const variants=[],opts=[...(colors.length?[{n:"Colour",v:colors}]:[]),...(sizes.length?[{n:"Size",v:sizes}]:[])];
    (colors.length?colors:[""]).forEach((c,ci)=>(sizes.length?sizes:[""]).forEach((s,si)=>variants.push({id:id+":"+(c?c+"-":"")+s,o:[c,s].filter(Boolean),sku:"",bc:"",price:null,cost:null,active:true,q:(stock[ci]||[])[si]||0})));
    return {p:{id,name,cat,brand:"",desc:"",price,cost,color,archived:false,hsn:"",gst:null,code:"",opts,variants}};
  };
  const S5=["S","M","L","XL","XXL"],W=["28","30","32","34","36"];
  const one=(id,name,cat,price,cost,q,ci)=>mk(id,name,cat,price,cost,[],[],[[q]],COLORS[ci%COLORS.length]);
  const OTHER={
    grocery:[one("g1","Basmati Rice 5 kg","Staples",549,470,24,0),one("g2","Toor Dal 1 kg","Pulses",169,138,30,1),one("g3","Sunflower Oil 1 L","Oils",155,128,40,2),one("g4","Sugar 1 kg","Staples",48,41,60,3),
      one("g5","Atta 10 kg","Staples",489,420,15,4),one("g6","Tea 500 g","Beverages",285,236,18,5),one("g7","Bathing Soap","Personal care",45,33,48,6),one("g8","Detergent 1 kg","Household",125,98,22,7)],
    electronics:[mk("e1","USB-C Fast Charger 25W","Chargers",1299,780,["Black","White"],[],[[12],[8]],COLORS[0]),mk("e2","Wireless Earbuds","Audio",1999,1250,["Black","White"],[],[[9],[6]],COLORS[1]),
      one("e3","USB-C Cable 1 m","Cables",349,160,30,2),one("e4","Power Bank 10000 mAh","Power banks",1499,980,10,3),mk("e5","Phone Cover","Accessories",399,140,["Clear","Black"],[],[[25],[18]],COLORS[4]),
      one("e6","Tempered Glass","Accessories",249,60,40,5),one("e7","Bluetooth Speaker","Audio",2499,1700,6,6),one("e8","Smart Watch Strap","Wearables",599,260,14,7)],
    restaurant:[one("r1","Masala Dosa","Breakfast",120,48,50,0),one("r2","Idli Vada","Breakfast",90,32,50,1),one("r3","Paneer Butter Masala","Mains",260,110,50,2),one("r4","Veg Biryani","Mains",220,90,50,3),
      one("r5","Butter Naan","Breads",50,14,50,4),one("r6","Masala Chai","Drinks",30,9,50,5),one("r7","Cold Coffee","Drinks",120,38,50,6),one("r8","Gulab Jamun","Desserts",70,22,50,7)],
  };
  const list=OTHER[type]||[
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
  if(refuse("manage_products","add products"))return;
  const ex=exampleCatalog(shopType());
  store.catalog=ex.cat;Object.assign(store.moves,ex.moves);saveCatalog();saveMoves();
  renderAll();
  if(store.authUser)pushLocalToSupabase();
}
