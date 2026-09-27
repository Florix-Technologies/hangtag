// SVG → PNG in the browser (a raster copy of a sticker or code, for apps that can't take SVG).

/* A PNG Blob of an SVG string. scale: output pixels per SVG pixel (default 4, sharp enough for 300 dpi labels) */
export function svgToPngBlob(svg, { scale = 4 } = {}){
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    const img = new Image();
    img.onload = () => {
      try{
        const c = document.createElement("canvas");
        c.width = Math.max(1, Math.round(img.naturalWidth * scale));
        c.height = Math.max(1, Math.round(img.naturalHeight * scale));
        const g = c.getContext("2d");
        g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height);
        g.drawImage(img, 0, 0, c.width, c.height);
        c.toBlob(b => { URL.revokeObjectURL(url); b ? resolve(b) : reject(new Error("PNG export failed")); }, "image/png");
      }catch(e){ URL.revokeObjectURL(url); reject(e); }
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("PNG export failed")); };
    img.src = url;
  });
}
