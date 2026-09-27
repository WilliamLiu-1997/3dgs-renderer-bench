from pathlib import Path
import json, statistics
import numpy as np
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

ROOT=Path(__file__).resolve().parent.parent
O=ROOT/'outputs'
D=json.loads((O/'benchmark-data.json').read_text())
plt.rcParams.update({'font.family':'DejaVu Sans','font.size':10,'axes.spines.top':False,'axes.spines.right':False,'axes.spines.left':False,'axes.facecolor':'#f6f5f1','figure.facecolor':'#f6f5f1','savefig.facecolor':'#f6f5f1','axes.labelcolor':'#182327','text.color':'#182327','xtick.color':'#657071','ytick.color':'#182327'})
colors={'spark':'#a75e2d','pc-gl':'#287c62','pc-gpu':'#558c29','supersplat':'#b24b72','gsl-gl':'#3976ae','gsl-gpu':'#7454a1'}
labels={'spark':'Spark / WebGL2','pc-gl':'PlayCanvas / WebGL2','pc-gpu':'PlayCanvas / WebGPU','supersplat':'SuperSplat / WebGPU','gsl-gl':'GSL / WebGL2','gsl-gpu':'GSL / WebGPU'}
scenarios=[('moving','Moving · main view'),('static','Static · main view'),('close-moving','Moving · closer side view'),('close','Static · closer side view')]
groups=[('sorted','Depth-sorted rendering',list(colors),0),('stochastic','Raw stochastic rendering',['pc-gpu','supersplat','gsl-gl','gsl-gpu'],7.2)]
fig,axs=plt.subplots(4,2,figsize=(16,24))
fig.subplots_adjust(left=.15,right=.97,top=.88,bottom=.07,wspace=.55,hspace=.42)
for col,(model,name) in enumerate([('elevator','Elevator / 2,796,503 splats'),('hotel','HotelFareza / 12,202,010 splats')]):
 for row,(scenario,view) in enumerate(scenarios):
  ax=axs[row,col];all_values=[];annotations=[];positions=[];tick_labels=[]
  for variant,group,modes,offset in groups:
   values=[];mins=[];maxs=[]
   for mode in modes:
    arr=[c['completionP50'] for c in D['cases'] if c['model']==model and c['mode']==mode and c['precision']=='default' and c['scenario']==scenario and c['variant']==variant]
    value=statistics.median(arr);values.append(value);mins.append(value-min(arr));maxs.append(max(arr)-value)
   pos=np.arange(len(modes))+offset
   ax.barh(pos,values,color=[colors[m] for m in modes],height=.62,zorder=3,xerr=[mins,maxs],error_kw={'ecolor':'#182327','capsize':2,'lw':1})
   ax.text(0,offset-.85,group,fontsize=9,color='#657071',va='center')
   best=min(round(v,2) for v in values)
   annotations.extend((y,v,err,round(v,2)==best) for y,v,err in zip(pos,values,maxs))
   all_values.extend(v+err for v,err in zip(values,maxs));positions.extend(pos);tick_labels.extend(labels[m] for m in modes)
  maximum=max(all_values)
  ax.set_yticks(positions,tick_labels,fontsize=9);ax.set_ylim(10.9,-1.6);ax.tick_params(axis='y',length=0,pad=8)
  ax.grid(axis='x',alpha=.2,zorder=0);ax.set_xlabel('Frame Completion P50 (ms) · lower is better')
  ax.set_title(view+'\n'+name,loc='left',fontweight='bold',fontsize=13,pad=20);ax.set_xlim(0,maximum*1.38)
  ax.axhline(6.1,color='#d4d8d2',lw=.8)
  for y,value,error,best in annotations:
   ax.text(value+error+maximum*.02,y,f'{value:.2f}'+('  BEST' if best else ''),va='center',fontsize=9,fontweight='bold' if best else 'normal',color='#17613b' if best else '#182327')
dates=' – '.join(dict.fromkeys([D['testDates'][0],D['testDates'][-1]]))
fig.text(.045,.966,'3DGS Renderer Bench',fontsize=30,weight='bold')
fig.text(.045,.947,f"Tested {dates} ({D['testTimeZone']}) · GSL {D['versions']['gsl']} · Spark {D['versions']['spark']} · PlayCanvas {D['versions']['playcanvas']} · SuperSplat {D['versions']['supersplat']}",fontsize=11,color='#657071')
fig.text(.045,.934,'Apple M5 Pro · 16 GPU cores · 48 GiB · 3024 × 1964 physical pixels · DPR 2 · Full PLY / SH3',fontsize=11,color='#657071')
fig.text(.045,.045,'Median of 3 independent runs; whiskers show run min/max. Sorted and raw stochastic groups have separate winners.',fontsize=10,color='#657071')
fig.text(.045,.032,'Unchanged rendering presets; moving views orbit ±45°. Raw stochastic: no spatial resolve or temporal accumulation.',fontsize=10,color='#657071')
fig.text(.045,.019,'GSL retains default 16-bit front-to-back stochastic sorting. PlayCanvas and SuperSplat raw stochastic skip depth sorting.',fontsize=10,color='#657071')
for extension in ['png','svg']:fig.savefig(O/('benchmark-overview.'+extension),dpi=180)
plt.close(fig)
svg=O/'benchmark-overview.svg'
svg.write_text('\n'.join(line.rstrip() for line in svg.read_text().splitlines())+'\n')
