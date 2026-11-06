from PIL import Image,ImageDraw,ImageFilter
from pathlib import Path
import math,random,sys
root=Path(sys.argv[1]); random.seed(7)
im=Image.new('RGB',(1600,800),'#070c22'); d=ImageDraw.Draw(im)
for x in range(0,1600,40): d.line((x,0,x,800),fill='#102644')
for y in range(0,800,40): d.line((0,y,1600,y),fill='#102644')
islands=[[(1080,85),(1120,116),(1180,125),(1145,157),(1137,210),(1096,184),(1050,196),(1016,168),(1041,131)],[(1024,232),(1055,237),(1049,285),(1018,307),(1017,351),(982,377),(971,413),(923,431),(900,464),(847,476),(815,499),(780,484),(746,506),(688,504),(666,481),(716,459),(761,453),(800,438),(825,411),(871,411),(893,380),(933,355),(945,316),(980,289)],[(738,518),(785,510),(817,522),(792,546),(754,552),(723,540)],[(662,520),(697,530),(701,562),(676,585),(672,622),(642,638),(620,611),(628,582),(601,564),(628,535)]]
for poly in islands:
    d.polygon(poly,fill='#133c68',outline='#59c9ff',width=4)
    d.line(poly+[poly[0]],fill='#59c9ff',width=3)
nodes=[(1090,151),(1022,260),(984,336),(952,386),(908,417),(855,448),(790,475),(714,485),(771,531),(660,566),(650,608)]
for a,b in zip(nodes,nodes[1:]): d.line([a,b],fill='#9052f3',width=4)
for x,y in nodes:
    d.ellipse((x-8,y-8,x+8,y+8),fill='#e2faff',outline='#0566d8',width=3)
    d.ellipse((x-17,y-17,x+17,y+17),outline='#0566d8',width=2)
for x,y,w,h in [(70,70,390,180),(70,290,390,190),(70,520,390,205),(1240,70,280,180),(1240,290,280,190),(1240,520,280,205)]:
    d.rounded_rectangle((x,y,x+w,y+h),radius=10,outline='#25527c',width=2)
    for j in range(4): d.line((x+15,y+25+j*35,x+w-15,y+25+j*35),fill='#142d4b')
    pts=[(x+18+k*(w-36)/20,y+h*.6+math.sin(k*.8)*h*.15+random.random()*h*.15) for k in range(21)]
    d.line(pts,fill='#0566d8',width=4)
    d.line([(xx,yy-20) for xx,yy in pts],fill='#9052f3',width=3)
im.save(root/'japan-noc.png')
