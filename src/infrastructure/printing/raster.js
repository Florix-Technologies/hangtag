// Pictures for thermal printers: a logo as one-bit rows (black dots), the "mono" image format of ePOS-Print.

/* RGBA pixels { width, height, data } → { width (a multiple of 8), height, base64 }. Transparent and light pixels stay white. */
export function monoRaster({width,height,data},{threshold=160}={}){
  const w8=Math.ceil(width/8)*8, rowBytes=w8/8, out=new Uint8Array(rowBytes*height);
  for(let y=0;y<height;y++) for(let x=0;x<width;x++){
    const i=(y*width+x)*4, a=data[i+3], lum=a<128?255:0.299*data[i]+0.587*data[i+1]+0.114*data[i+2];
    if(lum<threshold) out[y*rowBytes+(x>>3)]|=0x80>>(x&7);
  }
  let bin="";for(let k=0;k<out.length;k+=0x8000) bin+=String.fromCharCode.apply(null,out.subarray(k,k+0x8000));
  return {width:w8,height,base64:btoa(bin)};
}
/* A data URL drawn at most maxWidth dots wide (browser only), then made mono */
export function rasterizeLogo(dataUrl,maxWidth){
  return new Promise((resolve,reject)=>{
    const img=new Image();
    img.onload=()=>{
      const k=Math.min(1,maxWidth/img.naturalWidth), w=Math.max(1,Math.round(img.naturalWidth*k)), h=Math.max(1,Math.round(img.naturalHeight*k));
      const c=document.createElement("canvas");c.width=w;c.height=h;const g=c.getContext("2d");
      g.fillStyle="#fff";g.fillRect(0,0,w,h);g.drawImage(img,0,0,w,h);
      resolve(monoRaster(g.getImageData(0,0,w,h)));
    };
    img.onerror=()=>reject(new Error("Couldn't read the logo."));
    img.src=dataUrl;
  });
}
