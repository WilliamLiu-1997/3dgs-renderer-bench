from pathlib import Path
import json,statistics
import numpy as np
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
ROOT=Path(__file__).resolve().parent.parent;O=ROOT/'outputs';D=json.loads((O/'benchmark-data.json').read_text())
plt.rcParams.update({'font.family':'DejaVu Sans','font.size':11,'axes.spines.top':False,'axes.spines.right':False,'axes.spines.left':False,'axes.facecolor':'#f6f5f1','figure.facecolor':'#f6f5f1','savefig.facecolor':'#f6f5f1','axes.labelcolor':'#182327','text.color':'#182327','xtick.color':'#657071','ytick.color':'#182327'})
colors={'spark':'#a75e2d','supersplat':'#287c62','gsl-gl':'#3976ae','gsl-gpu':'#7454a1'}
labels={'spark':'Spark / WebGL2','supersplat':'SuperSplat / WebGPU','gsl-gl':'Gaussian Splat Lite\nWebGL2','gsl-gpu':'Gaussian Splat Lite\nWebGPU'}
keys=[('spark','default'),('supersplat','default'),('gsl-gl','default'),('gsl-gl','full'),('gsl-gpu','default'),('gsl-gpu','full')]
fig,axs=plt.subplots(2,2,figsize=(15,10),gridspec_kw={'width_ratios':[1,1]});fig.subplots_adjust(left=.20,right=.96,top=.82,bottom=.12,wspace=.64,hspace=.58)
for col,(model,name) in enumerate([('elevator','Elevator / 2,796,503 splats'),('hotel','HotelFareza / 12,202,010 splats')]):
 for row,(scenario,title) in enumerate([('moving','Moving camera'),('static','Fixed camera')]):
  ax=axs[row,col];values=[];mins=[];maxs=[]
  for mode,precision in keys:
   arr=[c['completionP50'] for c in D['cases'] if c['model']==model and c['mode']==mode and c['precision']==precision and c['scenario']==scenario]
   v=statistics.median(arr);values.append(v);mins.append(v-min(arr));maxs.append(max(arr)-v)
  pos=np.arange(len(keys));bars=ax.barh(pos,values,color=[colors[k[0]] for k in keys],height=.63,zorder=3,xerr=[mins,maxs],error_kw={'ecolor':'#182327','capsize':3,'lw':1})
  for i,b in enumerate(bars):
   if keys[i][1]=='full':b.set_alpha(.53);b.set_hatch('//')
  ax.set_yticks(pos,[labels[k[0]]+(' · full' if k[1]=='full' else '') for k in keys],fontsize=10);ax.invert_yaxis();ax.tick_params(axis='y',length=0,pad=10);ax.grid(axis='x',alpha=.2,zorder=0);ax.set_xlabel('Frame completion (ms) · lower is better');ax.set_title(title+'\n'+name,loc='left',fontweight='bold',fontsize=13,pad=17);ax.set_xlim(0,max(values)*1.3)
  for i,v in enumerate(values):ax.text(v+maxs[i]+max(values)*.02,i,f'{v:.2f}'+('  BEST' if v==min(values) else ''),va='center',fontsize=10,fontweight='bold' if v==min(values) else 'normal',color='#17613b' if v==min(values) else '#182327')
fig.text(.06,.947,'3DGS Renderer Bench',fontsize=29,weight='bold');fig.text(.06,.91,'Apple M5 Pro · 16 GPU cores · 48 GiB · 3024 × 1964 physical pixels · DPR 2',fontsize=13,color='#657071');fig.text(.06,.047,'Median of 3 independent runs; whiskers show run min/max. Original cameras, native rendering settings and non-radial sorting.',fontsize=10,color='#657071');fig.text(.06,.023,'Spark: extended source + accumulator. Gaussian Splat Lite: default and full-precision sorting. Raw PLY inputs, no MSAA, fixed resolution.',fontsize=10,color='#657071');fig.savefig(O/'benchmark-overview.png',dpi=180);fig.savefig(O/'benchmark-overview.svg');plt.close(fig)
