"""Small software renderer so the enclosure can be previewed without CAD. usage: render_stl.py out.png az el file.stl:#hex[:alpha-ignored] ..."""
import sys, numpy as np, struct
from PIL import Image
def load(p):
    b=open(p,'rb').read(); n=struct.unpack('<I',b[80:84])[0]
    a=np.frombuffer(b,dtype=np.dtype([('n','<3f4'),('v','<9f4'),('x','<u2')]),count=n,offset=84)
    return a['v'].reshape(-1,3,3).astype(np.float64)
def render(items,out,az,el,size=1100,ss=2,bg=(255,255,255)):
    az,el=np.radians(az),np.radians(el)
    Rz=np.array([[np.cos(az),0,np.sin(az)],[0,1,0],[-np.sin(az),0,np.cos(az)]])
    Rx=np.array([[1,0,0],[0,np.cos(el),-np.sin(el)],[0,np.sin(el),np.cos(el)]])
    R=Rx@Rz; tris=[(load(f)@R.T,c) for f,c in items]
    allv=np.vstack([t.reshape(-1,3) for t,_ in tris]); lo=allv.min(0); hi=allv.max(0)
    S=size*ss; k=0.9*S/max(hi[0]-lo[0],hi[1]-lo[1]); c=(lo+hi)/2
    Z=np.full((S,S),-1e9); I=np.zeros((S,S,3))+np.array(bg)
    L=np.array([.35,.6,.72]); L/=np.linalg.norm(L); F=np.array([-.6,-.1,.5]); F/=np.linalg.norm(F)
    for T,col in tris:
        col=np.array(col,float)
        for t in T:
            n=np.cross(t[1]-t[0],t[2]-t[0]); ln=np.linalg.norm(n)
            if ln==0 or n[2]<=0: continue
            n/=ln; sh=.32+.6*max(0,n@L)+.16*max(0,n@F)
            p=np.c_[(t[:,0]-c[0])*k+S/2,S/2-(t[:,1]-c[1])*k,(t[:,2]-c[2])*k]
            x0,x1=int(max(p[:,0].min(),0)),int(min(p[:,0].max()+1,S-1)); y0,y1=int(max(p[:,1].min(),0)),int(min(p[:,1].max()+1,S-1))
            if x1<x0 or y1<y0: continue
            xs,ys=np.meshgrid(np.arange(x0,x1+1),np.arange(y0,y1+1))
            d=(p[1,1]-p[2,1])*(p[0,0]-p[2,0])+(p[2,0]-p[1,0])*(p[0,1]-p[2,1])
            if abs(d)<1e-9: continue
            a=((p[1,1]-p[2,1])*(xs-p[2,0])+(p[2,0]-p[1,0])*(ys-p[2,1]))/d
            b=((p[2,1]-p[0,1])*(xs-p[2,0])+(p[0,0]-p[2,0])*(ys-p[2,1]))/d
            g=1-a-b; m=(a>=0)&(b>=0)&(g>=0)
            z=a*p[0,2]+b*p[1,2]+g*p[2,2]
            w=m&(z>Z[y0:y1+1,x0:x1+1])
            Z[y0:y1+1,x0:x1+1][w]=z[w]; I[y0:y1+1,x0:x1+1][w]=np.clip(col*sh,0,255)
    Image.fromarray(I.astype('uint8')).resize((size,size),Image.LANCZOS).save(out)
if __name__=='__main__':
    out,az,el=sys.argv[1],float(sys.argv[2]),float(sys.argv[3]); its=[]
    for a in sys.argv[4:]:
        f,c=a.split(':'); c=c.lstrip('#'); its.append((f,tuple(int(c[i:i+2],16) for i in (0,2,4))))
    render(its,out,az,el)
