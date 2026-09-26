from pathlib import Path
import json,statistics
import numpy as np
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
ROOT=Path(__file__).resolve().parent.parent;O=ROOT/'outputs';D=json.loads((O/'benchmark-data.json').read_text())
plt.rcParams.update({'font.family':'DejaVu Sans','font.size':11,'axes.spines.top':False,'axes.spines.right':False,'axes.spines.left':False,'axes.facecolor':'#f6f5f1','figure.facecolor':'#f6f5f1','savefig.facecolor':'#f6f5f1','axes.labelcolor':'#182327','text.color':'#182327','xtick.color':'#657071','ytick.color':'#182327'})
colors={'spark':'#a75e2d','pc-gl':'#287c62','pc-gpu':'#558c29','supersplat':'#b24b72','gsl-gl':'#3976ae','gsl-gpu':'#7454a1'}
labels={'spark':'Spark / WebGL2','pc-gl':'PlayCanvas / WebGL2','pc-gpu':'PlayCanvas / WebGPU','supersplat':'SuperSplat\nWebGPU','gsl-gl':'Gaussian Splat Lite\nWebGL2','gsl-gpu':'Gaussian Splat Lite\nWebGPU'}
def plot(filename,title,modes,scenarios,note):
 fig,axs=plt.subplots(2,2,figsize=(15,10));fig.subplots_adjust(left=.20,right=.96,top=.82,bottom=.12,wspace=.64,hspace=.58)
 for col,(model,name) in enumerate([('elevator','Elevator / 2,796,503 splats'),('hotel','HotelFareza / 12,202,010 splats')]):
  for row,(scenario,view) in enumerate(scenarios):
   ax=axs[row,col];values=[];mins=[];maxs=[]
   for mode in modes:
    arr=[c['completionP50'] for c in D['cases'] if c['model']==model and c['mode']==mode and c['precision']=='default' and c['scenario']==scenario]
    v=statistics.median(arr);values.append(v);mins.append(v-min(arr));maxs.append(max(arr)-v)
   pos=np.arange(len(modes));ax.barh(pos,values,color=[colors[m] for m in modes],height=.63,zorder=3,xerr=[mins,maxs],error_kw={'ecolor':'#182327','capsize':3,'lw':1})
   ax.set_yticks(pos,[labels[m] for m in modes],fontsize=10);ax.invert_yaxis();ax.tick_params(axis='y',length=0,pad=10);ax.grid(axis='x',alpha=.2,zorder=0);ax.set_xlabel('Frame Completion P50 (ms) · lower is better');ax.set_title(view+'\n'+name,loc='left',fontweight='bold',fontsize=13,pad=17);ax.set_xlim(0,max(values)*1.3)
   for i,v in enumerate(values):ax.text(v+maxs[i]+max(values)*.02,i,f'{v:.2f}'+('  BEST' if v==min(values) else ''),va='center',fontsize=10,fontweight='bold' if v==min(values) else 'normal',color='#17613b' if v==min(values) else '#182327')
 fig.text(.06,.947,title,fontsize=29,weight='bold');fig.text(.06,.91,'Apple M5 Pro · 16 GPU cores · 48 GiB · 3024 × 1964 physical pixels · DPR 2',fontsize=13,color='#657071');fig.text(.06,.047,'Median of 3 independent runs; whiskers show run min/max. Original cameras; rendering settings adjusted as closely as possible.',fontsize=10,color='#657071');fig.text(.06,.023,note,fontsize=10,color='#657071');fig.savefig(O/(filename+'.png'),dpi=180);fig.savefig(O/(filename+'.svg'));plt.close(fig)
plot('benchmark-overview','3DGS Renderer Bench',list(colors),[('moving','Moving camera ±45°'),('static','Fixed camera')],'Camera-axis depth sorting. Spark: extended source + accumulator. GSL: default sorting only. Full PLY inputs, no MSAA.')
plot('benchmark-stochastic','3DGS Renderer Bench · Raw stochastic',['pc-gpu','supersplat','gsl-gl','gsl-gpu'],[('stochastic-moving','Moving camera ±45°'),('stochastic','Fixed camera')],'No depth sorting, spatial resolve or temporal accumulation. PlayCanvas: native blue noise. SuperSplat: native depth occlusion enabled.')

plot('benchmark-resolved','3DGS Renderer Bench · Spatial resolve',['supersplat','gsl-gl','gsl-gpu'],[('stochastic-resolved-moving','Moving camera ±45°'),('stochastic-resolved','Fixed camera')],'Native stochastic sampling and spatial filters; no temporal accumulation. SuperSplat: native depth occlusion enabled; warp and adaptive contribution off.')
