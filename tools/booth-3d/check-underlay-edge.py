import bpy,json,math,os,sys
a=sys.argv[sys.argv.index('--')+1:]; base_path,cand_path,meta_path,out_json,compare_path=map(os.path.abspath,a[:5]); meta=json.load(open(meta_path,encoding='utf-8'))
def load(p):
 im=bpy.data.images.load(p,check_existing=False); w,h=im.size; raw=list(im.pixels[:]); grey=[.2126*raw[i*4]+.7152*raw[i*4+1]+.0722*raw[i*4+2] for i in range(w*h)]; return im,w,h,grey,raw
base,bw,bh,bg,br=load(base_path); cand,cw,ch,cg,cr=load(cand_path)
if (cw,ch)!=(bw,bh): cand.scale(bw,bh); cand.filepath_raw=cand_path; cand.file_format='PNG'; cand.save(); bpy.data.images.remove(cand); cand,cw,ch,cg,cr=load(cand_path)
e=meta['front_top_edge_px']; x0=max(2,round(min(e[0][0],e[1][0]))); x1=min(bw-3,round(max(e[0][0],e[1][0]))); expected=(e[0][1]+e[1][1])/2; booth_h=meta['booth_height_px']; radius=max(10,round(booth_h*.22))
def line_y(x): return e[0][1]+(e[1][1]-e[0][1])*(x-e[0][0])/(e[1][0]-e[0][0])
def score(offset):
 t=0
 for x in range(x0,x1+1):
  y=round(line_y(x)+offset)
  gx=(cg[(y-1)*bw+x+1]+2*cg[y*bw+x+1]+cg[(y+1)*bw+x+1])-(cg[(y-1)*bw+x-1]+2*cg[y*bw+x-1]+cg[(y+1)*bw+x-1]); gy=(cg[(y+1)*bw+x-1]+2*cg[(y+1)*bw+x]+cg[(y+1)*bw+x+1])-(cg[(y-1)*bw+x-1]+2*cg[(y-1)*bw+x]+cg[(y-1)*bw+x+1]); t+=math.hypot(gx,gy)
 return t/(x1-x0+1)
s,offset=max((score(d),d) for d in range(-radius,radius+1)); found=expected+offset; shift=offset/booth_h*100; min_shift,max_shift=-25,5; passed=min_shift<=shift<=max_shift; result={'expected_top_y_px':expected,'detected_top_y_px':found,'top_shift_percent':shift,'threshold_percent':{'min':min_shift,'max':max_shift},'sobel_score':s,'passed':passed,'search_x_px':[x0,x1]}; json.dump(result,open(out_json,'w',encoding='utf-8'),ensure_ascii=False,indent=2)
out=bpy.data.images.new('comparison',width=bw*2,height=bh,alpha=True); dst=[0.0]*(bw*2*bh*4)
for yy in range(bh):
 for x in range(bw):
  si=(yy*bw+x)*4; di=(yy*bw*2+x)*4; dst[di:di+4]=br[si:si+4]; di=(yy*bw*2+bw+x)*4; dst[di:di+4]=cr[si:si+4]
out.pixels[:]=dst; out.filepath_raw=compare_path; out.file_format='PNG'; out.save(); print(json.dumps(result,ensure_ascii=False)); sys.exit(0 if passed else 2)
