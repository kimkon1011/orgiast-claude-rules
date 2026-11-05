import bpy, json, math, os, sys

argv=sys.argv[sys.argv.index('--')+1:]
base_path, candidate_path, meta_path, out_json, compare_path = map(os.path.abspath,argv[:5])
meta=json.load(open(meta_path,encoding='utf-8'))

def pixels(path):
  im=bpy.data.images.load(path,check_existing=False); w,h=im.size
  raw=list(im.pixels[:]); grey=[0.0]*(w*h)
  for i in range(w*h): grey[i]=.2126*raw[i*4]+.7152*raw[i*4+1]+.0722*raw[i*4+2]
  return im,w,h,grey,raw

base,bw,bh,bg,br=pixels(base_path); cand,cw,ch,cg,cr=pixels(candidate_path)
if (cw,ch)!=(bw,bh):
  cand.scale(bw,bh); cand.filepath_raw=candidate_path; cand.file_format='PNG'; cand.save(); bpy.data.images.remove(cand); cand,cw,ch,cg,cr=pixels(candidate_path)

edges=meta['front_top_edge_px']; x0=max(2,round(min(edges[0][0],edges[1][0]))); x1=min(bw-3,round(max(edges[0][0],edges[1][0])))
expected=(edges[0][1]+edges[1][1])/2; booth_h=meta['booth_height_px']; radius=max(10,round(booth_h*.22))

def row_score(g,y):
  total=0.0
  for x in range(x0,x1+1):
    gx=(g[(y-1)*bw+x+1]+2*g[y*bw+x+1]+g[(y+1)*bw+x+1])-(g[(y-1)*bw+x-1]+2*g[y*bw+x-1]+g[(y+1)*bw+x-1])
    gy=(g[(y+1)*bw+x-1]+2*g[(y+1)*bw+x]+g[(y+1)*bw+x+1])-(g[(y-1)*bw+x-1]+2*g[(y-1)*bw+x]+g[(y-1)*bw+x+1])
    total += math.hypot(gx,gy)
  return total/(x1-x0+1)

scores=[(row_score(cg,y),y) for y in range(max(2,round(expected-radius)),min(bh-2,round(expected+radius))+1)]
score,found=max(scores); shift=(found-expected)/booth_h*100; passed=abs(shift)<=5
result={'expected_top_y_px':expected,'detected_top_y_px':found,'top_shift_percent':shift,'threshold_percent':5,'sobel_score':score,'passed':passed,'search_x_px':[x0,x1]}
json.dump(result,open(out_json,'w',encoding='utf-8'),ensure_ascii=False,indent=2)

# Side-by-side comparison PNG.
out=bpy.data.images.new('comparison',width=bw*2,height=bh,alpha=True); dst=[0.0]*(bw*2*bh*4)
for y in range(bh):
  for x in range(bw):
    si=(y*bw+x)*4; di=(y*bw*2+x)*4; dst[di:di+4]=br[si:si+4]; di2=(y*bw*2+bw+x)*4; dst[di2:di2+4]=cr[si:si+4]
out.pixels[:]=dst; out.filepath_raw=compare_path; out.file_format='PNG'; out.save()
print(json.dumps(result,ensure_ascii=False))
sys.exit(0 if passed else 2)
