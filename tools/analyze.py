from pathlib import Path
import json, statistics, csv, io, shutil, base64, datetime, math, sys
import numpy as np
from PIL import Image
ROOT=Path(__file__).resolve().parent.parent
H=ROOT/'harness'; O=ROOT/('report-preview' if '--preview' in sys.argv else 'outputs'); O.mkdir(exist_ok=True)
R=H/'results'
q=lambda a,p:float(np.percentile(a,p)) if len(a) else None
mb=lambda v:v/2**20 if v is not None else None
def cpu_memory_mib(case):
 heap=case['heap']
 return mb(heap['usedSize']+heap['backingStorageSize']+heap['workerBackingStorageSize']+case['memory']['workerWasmBytes'])
def sort_span(row):
 passes=[p for p in row.get('passes',[]) if p['stage']=='sort']
 return (max(p['end'] for p in passes)-min(p['start'] for p in passes))/1e6 if passes else None
D={'generated':datetime.datetime.now().astimezone().isoformat(timespec='seconds'),'cases':[],'sort':[],'memory':[],'images':[],'quality':[],'runs':[]}
D['metrics']={
 'completionP50':'Per-run 50th percentile of submission + GPU completion + query readback, milliseconds',
 'completionP95':'Per-run 95th percentile of the same frame-completion samples, milliseconds',
 'cpuMemoryMiB':'Sum of main + live Worker JS heaps, main + Worker ArrayBuffer/external backing storage, and Worker WASM capacity, MiB; accounting sum, not deduplicated physical memory',
 'gpuMiB':'Explicit live GPU resource capacity excluding timing-query buffers, MiB; not physical VRAM',
 'memoryAggregation':'Sum CPU components within each snapshot first, then take the maximum across sorted cases per run and median across three runs; GPU is aggregated separately'
}
config=json.loads((H/'config.json').read_text())
files=sorted(p for p in R.glob('*.json') if not p.name.startswith('._'))
if not files: raise SystemExit('No completed formal data')
if (O/'images').exists(): shutil.rmtree(O/'images')
for f in files:
 d=json.loads(f.read_text())
 if d['config']!=config: raise SystemExit('Stale configuration: '+f.name)
 if d.get('failure'): print('FAILED',f.name,d['failure']);continue
 D['browser']=d['browser'];D['versions']=d['config']['versions'];D['rounds']=max(d['round'],D.get('rounds',0))
 D['runs'].append({'name':d['name'],'started':d['started'],'loadMs':d['initial']['loadMs'],'gpuInfo':d['initial']['gpuInfo'],'resolution':d['initial']['resolution'],'dpr':d['initial']['dpr'],'camera':d['initial']['camera'],'renderParameters':d['initial']['state'].get('renderParameters'),'sortRadial':d['initial']['state'].get('sortRadial'),'protocol':d['config'].get('protocol'),'motionAmplitudeDegrees':d['config']['motionAmplitudeDegrees']})
 for c in d['cases']:
  scenario=c['variant'] if c['variant']!='sorted' else 'moving' if c['moving'] else 'close' if c['angle'] else 'static'
  # Keep moving stochastic samples in the downloadable data as distinct scenarios.
  if c['variant'].startswith('stochastic') and c['moving']: scenario+='-moving'
  row={'model':d['model'],'mode':d['mode'],'round':d['round'],'precision':'full' if c['fast'] is False else 'default','scenario':scenario,'n':len(c['rows']),'visibleOrActive':c['visible'],'cpuP50':q([r['cpuSubmitMs'] for r in c['rows']],50),'completionP50':q([r['completionMs'] for r in c['rows']],50),'completionP95':q([r['completionMs'] for r in c['rows']],95),'gpuMiB':mb(c['memory']['gpuBytes']),'cpuMemoryMiB':cpu_memory_mib(c),'workerP50':q([r['workerMs'] for r in c['rpc'] if r['name'].startswith('sort') and r['workerMs'] is not None],50),'asyncP50':q([j['ms'] for j in c['sortJobs']],50),'rpcP50':q([r['roundTripMs'] for r in c['rpc'] if r['name'].startswith('sort')],50)}
  D['cases'].append(row)
 sorted_cases=[c for c in d['cases'] if c['variant']=='sorted']
 D['memory'].append({'model':d['model'],'mode':d['mode'],'round':d['round'],'precision':'default','scenario':'memory','gpuMiB':max(mb(c['memory']['gpuBytes']) for c in sorted_cases),'cpuMemoryMiB':max(cpu_memory_mib(c) for c in sorted_cases)})
 for c in d['sort']:
  rpc=[rpc for row in c['rows'] for rpc in row['rpc'] if rpc['name'].startswith('sort')]
  jobs=[job for row in c['rows'] for job in row['sortJobs']]
  D['sort'].append({'model':d['model'],'mode':d['mode'],'round':d['round'],'precision':'full' if c['fast'] is False else 'default','workerP50':q([r['workerMs'] for r in rpc if r['workerMs'] is not None],50),'rpcP50':q([r['roundTripMs'] for r in rpc],50),'asyncP50':q([j['ms'] for j in jobs],50),'gpuSortP50':q([sort_span(r) for r in c['rows'] if sort_span(r) is not None],50),'gpuSortPassSumP50':q([r['gpuSortMs'] for r in c['rows'] if r.get('gpuSortMs',0)>0],50),'cpuUpdateP50':q([r['updateMs'] for r in c['rows']],50),'gpuIsolation':c['gpuIsolation']})
 # Pick round 1 captures for a fixed, reproducible gallery.
 if d['round']==1:
  (O/'images').mkdir(exist_ok=True)
  ref=np.asarray(Image.open(R/(d['name']+'-sorted.png')).convert('RGB'),dtype=np.float32)
  for variant in ['sorted','stochastic','stochastic-resolved']:
   p=R/(d['name']+'-'+variant+'.png')
   if not p.exists():continue
   dest=O/'images'/p.name;shutil.copy2(p,dest)
   im=Image.open(p).convert('RGB');im.thumbnail((1280,832));b=io.BytesIO();im.save(b,format='JPEG',quality=88)
   D['images'].append({'model':d['model'],'mode':d['mode'],'variant':variant,'path':'images/'+p.name,'thumb':'data:image/jpeg;base64,'+base64.b64encode(b.getvalue()).decode()})
   image=np.asarray(Image.open(p).convert('RGB'),dtype=np.float32);delta=image-ref;mse=float(np.mean(delta**2));mae=float(np.mean(abs(delta)))
   D['quality'].append({'model':d['model'],'mode':d['mode'],'variant':variant,'mae':mae,'psnr':10*math.log10(255**2/mse) if mse else None})
assert all(r['resolution']==[3024,1964] and r['dpr']==2 for r in D['runs'])
plain={**D,'images':[{k:v for k,v in im.items() if k!='thumb'} for im in D['images']]}
(O/'benchmark-data.json').write_text(json.dumps(plain,ensure_ascii=False,indent=2))
with open(O/'benchmark-summary.csv','w',encoding='utf-8-sig',newline='') as f:
 w=csv.DictWriter(f,fieldnames=D['cases'][0].keys());w.writeheader();w.writerows(D['cases'])
html=(ROOT/'tools/report_template.html').read_text();html=html.replace('__BENCHMARK_DATA__',json.dumps(D,ensure_ascii=False,separators=(',',':')).replace('</','<\\/'));(O/'3DGS-Renderer-Bench.html').write_text(html)
print('Generated',len(D['runs']),'runs',len(D['cases']),'cases',len(D['images']),'images')
for model in ['elevator','hotel']:
 for mode in ['spark','pc-gl','pc-gpu','supersplat','gsl-gl','gsl-gpu']:
  for precision in ['default']:
   rows=[r for r in D['cases'] if r['model']==model and r['mode']==mode and r['precision']==precision and r['scenario']=='static']
   print(model,mode,precision,'Frame Completion P50', [round(r['completionP50'],2) for r in rows])
