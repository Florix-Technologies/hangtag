// Files in the browser: save/download, photo to thumbnail.
import { toast } from '../../shared/components/toast.js';
import { logger } from '../../shared/logging/logger.js';

export async function saveFile(name,data,type){
  try{const u=URL.createObjectURL(data instanceof Blob?data:new Blob([data],{type}));const a=document.createElement("a");a.href=u;a.download=name;a.rel="noopener";document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(u),5000);return true}
  catch(e){logger.error("Download failed:",e);toast("Couldn't download the file.");return false}
}
export async function fileToThumb(file,size){
  const url=URL.createObjectURL(file);
  try{
    const img=await new Promise((res,rej)=>{const i=new Image();i.onload=()=>res(i);i.onerror=rej;i.src=url});
    const s=Math.min(img.naturalWidth,img.naturalHeight);if(!s)throw new Error("empty");
    const c=document.createElement("canvas");c.width=c.height=size;const x=c.getContext("2d");
    x.fillStyle="#fff";x.fillRect(0,0,size,size);x.imageSmoothingQuality="high";
    x.drawImage(img,(img.naturalWidth-s)/2,(img.naturalHeight-s)/2,s,s,0,0,size,size);
    return c.toDataURL("image/jpeg",.8);
  }finally{URL.revokeObjectURL(url)}
}

/* SHA-256 of a file's bytes as hex: the fingerprint that spots the same bill uploaded twice */
export async function sha256Hex(blob){
  const buf = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}
/* A photo shrunk to at most maxPx on its longer side, as JPEG (bills stay readable, uploads stay small) */
export function downscaleImage(file, { maxPx = 2000, quality = 0.85 } = {}){
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file), img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const k = Math.min(1, maxPx / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement("canvas"); c.width = Math.max(1, Math.round(img.naturalWidth * k)); c.height = Math.max(1, Math.round(img.naturalHeight * k));
      const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);
      c.toBlob(b => b ? resolve(b) : reject(new Error("Couldn't read that picture.")), "image/jpeg", quality);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Couldn't read that picture.")); };
    img.src = url;
  });
}
/* A Blob as base64 (no data: prefix) */
export function readAsBase64(blob){
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ""));
    r.onerror = () => reject(r.error || new Error("Couldn't read the file."));
    r.readAsDataURL(blob);
  });
}
