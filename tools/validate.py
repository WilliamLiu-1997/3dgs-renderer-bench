from pathlib import Path
import json, math, sys, datetime, os
from zoneinfo import ZoneInfo

ROOT=Path(__file__).resolve().parent.parent
R=Path(os.environ.get('RESULTS_DIR', ROOT/'harness/results-current'))
counts={'elevator':2796503,'hotel':12202010,'willa':14469103}
config=json.loads((ROOT/'harness/config.json').read_text())
expected_cases={'spark':4,'pc-gl':4,'pc-gpu':8,'viewer-gpu':4,'radix-gpu':4,'radix-gl':4,'gsl-gl':8,'gsl-gpu':8}
models=[m for m in counts if '--'+m in sys.argv] or counts
round_count=1 if '--single' in sys.argv else 3
expected={f'{model}-{mode}-r{round}' for model in models for mode in expected_cases for round in range(1,round_count+1)}
actual={f.stem for f in R.glob('*.json') if not f.name.startswith('._')}
actual={name for name in actual if any(name.startswith(model+'-') for model in models)}
if '--partial' not in sys.argv:
 assert actual==expected, f'Missing: {expected-actual}; extra: {actual-expected}'
frames=0;groups=0;sort_groups=0;browser=set();resolutions=set();test_dates=set()
gsl_defaults={'minPixelRadius':1,'preBlurAmount':.3,'blurAmount':0,'clipXY':1.25,'focalAdjustment':2,'minAlpha':1/255}
spark_defaults={'minPixelRadius':2,'maxPixelRadius':512,'preBlurAmount':.3,'blurAmount':0,'clipXY':1.25,'focalAdjustment':2,'minAlpha':1/255}
initial_orders={};execution=[];sort_execution=[]
for name in sorted(actual):
 d=json.loads((R/(name+'.json')).read_text());mode=d['mode'];initial=d['initial']
 assert not d.get('failure'), (name,d.get('failure'))
 assert not d['consoleErrors'],(name,d['consoleErrors'])
 execution.append((d['started'],d['round'],d['model'],mode))
 assert initial['resolution']==[3024,1964] and initial['dpr']==2,name
 assert initial['state']['sourceCount']==counts[d['model']],name
 assert initial['state']['sh']==3,name
 assert d['config']==config,name
 assert len(d['order'])==len(set(d['order'])) and mode in d['order'],name
 if d['round']==1:
  if d['model'] in initial_orders:assert d['order']==initial_orders[d['model']],name
  initial_orders[d['model']]=d['order']
 if d['model'] in initial_orders:
  base=initial_orders[d['model']];shift=((d['round']-1)//2)%len(base);order=base[shift:]+base[:shift]
  if d['round']%2==0:order.reverse()
  assert d['order']==order,name
 assert d['config']['protocol']==config['protocol'],name
 assert d['config']['versions']==config['versions'],name
 expected_parameters=spark_defaults if mode=='spark' else gsl_defaults if mode.startswith('gsl') else {'method':'ewa','sortBits':24,'sourceType':'extSplats','sortMode':'gpu' if mode=='radix-gpu' else 'cpu'} if mode.startswith('radix') else {'minPixelSize':2,'minContribution':0,'alphaClipForward':1/255,'antiAlias':False,'colorUpdateAngle':0,'radialSorting':True,'dataFormat':'large'}
 assert initial['state']['sortRadial'] is True,name
 assert all(initial['state']['renderParameters'][k]==v for k,v in expected_parameters.items()),name
 if mode.startswith('gsl'):assert initial['state']['reversedDepthBuffer'] is True,name
 camera=config['models'][d['model']]
 assert initial['camera']['position']==[a+b for a,b in zip(camera['target'],camera['offset'])],name
 assert len(d['cases'])==expected_cases[mode],name
 assert len(d['sort'])==1,name
 if mode=='spark':
  assert 'ExtSplats' in initial['state']['sourceType'] and initial['state']['accumulatorExtended'],name
  assert initial['state']['lodEnabled'] is True and initial['state']['hasLodData'] is False,name
 if mode=='viewer-gpu':
  assert initial['state']['engineVersion']==config['versions']['playcanvas'],name
  assert initial['state']['engineCommit']==config['commits']['playcanvas'],name
 if mode=='gsl-gpu':
  assert initial['state']['workingColorSpace']=='srgb' and initial['state']['outputColorSpace']=='srgb',name
  assert initial['state']['deviceConfiguration']=='three-default',name
  assert 'timestamp-query' in initial['state']['deviceFeatures'],name
  assert initial['state']['compatibilityMode']==('core-features-and-limits' not in initial['state']['deviceFeatures']),name
 variants=['sorted','stochastic'] if mode in ['pc-gpu','gsl-gl','gsl-gpu'] else ['sorted']
 expected_scenarios={(v,m,a,.65 if a else 1) for v in variants for m in [False,True] for a in [0,.55]}
 assert {(c['variant'],c['moving'],c['angle'],c['scale']) for c in d['cases']}==expected_scenarios,name
 test_dates.add(datetime.datetime.fromisoformat(d['started']).astimezone(ZoneInfo('Australia/Sydney')).date().isoformat())
 for c in d['cases']:
  assert c['motionAmplitudeDegrees']==(45 if c['moving'] else 0),name
  if c['moving']:
   angles=[r['cameraAngle'] for r in c['rows']]
   assert abs(min(angles)-(c['angle']-math.pi/4))<1e-12 and abs(max(angles)-(c['angle']+math.pi/4))<1e-12,name
  assert c['variant'] in ['sorted','stochastic'],name
  assert not c['errors'],name
  assert not c['memory']['unknownFormats'],(name,c['memory']['unknownFormats'])
  assert c['warm']['frames']>=20 and c['warm']['ms']>=1000,name
  assert len(c['rows'])>=(64 if c['variant']=='sorted' else 48),name
  assert all(math.isfinite(r['gpuMs']) and r['gpuMs']>0 for r in c['rows']),name
  assert c['memory']['gpuBytes']>0 and c['heap']['usedSize']>0,name
  heap=c['heap'];isolates=[heap['main'],*heap['workers']]
  assert all(math.isfinite(r['completionMs']) and r['completionMs']>0 for r in c['rows']),name
  assert len({i['isolateId'] for i in isolates})==len(isolates),name
  assert len(heap['workers'])==sum(w['alive'] for w in c['memory']['workers']),name
  assert all(i['usedSize']>0 and i['backingStorageSize']>=0 for i in isolates),name
  assert heap['usedSize']==sum(i['usedSize'] for i in isolates),name
  assert heap['workerUsedSize']==sum(i['usedSize'] for i in heap['workers']),name
  assert heap['workerBackingStorageSize']==sum(i['backingStorageSize'] for i in heap['workers']),name
  assert heap['backingStorageSize']==heap['main']['backingStorageSize'],name
  assert c['state']['stochastic']==c['variant'].startswith('stochastic'),name
  assert c['state']['sortRadial'] is True,name
  assert all(c['state']['renderParameters'][k]==v for k,v in expected_parameters.items()),name
  if mode.startswith('gsl'):
   assert c['state']['spatialResolve'] is False,name
  if mode=='pc-gpu' and c['variant']=='stochastic':
   assert c['state']['sorting']=='none' and c['state']['dither']=='bluenoise',name
   assert c['state']['spatialResolve'] is False and c['state']['temporalResolve'] is False,name
   assert all(not any(p['stage']=='sort' for p in r['passes']) for r in c['rows']),name
  if mode.startswith('gsl'):
   assert c['state']['fastSort'] is True and c['fast'] is True,name
   assert c['state']['stochasticSort'] is True,name
   assert c['state']['sortBits']==(16 if c['variant']=='stochastic' else 24),name
  frames+=len(c['rows']);groups+=1
 for s in d['sort']:
  if s.get('protocol')=='radix-sort-diagnostic-v1':
   assert mode.startswith('radix-') and s['browser']==d['browser'] and s['warmupSamples']==4,name
   assert not s['consoleErrors'],name
   assert s['order']==[m for m in d['order'] if m.startswith('radix-')],name
   sort_execution.append((s['measuredAt'],d['round'],d['model'],mode))
  if mode.startswith('gsl'):assert s['fast'] is True,name
  assert len(s['rows'])==16,name
  for row in s['rows']:
   if mode in ['spark','gsl-gl','pc-gl','radix-gl']:
    calls=[r for r in row['rpc'] if r['name'].startswith('sort')]
    assert calls and all(r['workerMs']>0 for r in calls),name
    assert row['sortJobs'] and all(j['ms']>0 for j in row['sortJobs']),name
   else:
    passes=[p for p in row['passes'] if p['stage']=='sort']
    assert passes and all(p['end']>p['start'] for p in passes),name
  sort_groups+=1
 browser.add(d['browser']);resolutions.add(tuple(initial['resolution']))
if '--partial' not in sys.argv:
 expected_execution=[]
 for round in range(1,round_count+1):
  for model in config['models']:
   if model not in models:continue
   base=initial_orders[model]
   assert set(base)==set(expected_cases),model
   shift=((round-1)//2)%len(base);order=base[shift:]+base[:shift]
   if round%2==0:order.reverse()
   expected_execution.extend((round,model,mode) for mode in order)
 assert [entry[1:] for entry in sorted(execution)]==expected_execution,'Execution timestamps do not match interleaved round order'
 if sort_execution:
  assert [entry[1:] for entry in sorted(sort_execution)]==[entry for entry in expected_execution if entry[2].startswith('radix-')],'Radix sort supplement order mismatch'
summary={'runs':len(actual),'performanceGroups':groups,'measuredFrames':frames,'sortGroups':sort_groups,'sortSamples':16*sort_groups,'renderingSettingsAdjustedAsCloselyAsPossible':True,'gslDefaultSortOnly':True,'playcanvasWebGPUStochastic':True,'rawStochasticOnly':True,'gslStochasticFrontToBackSort':True,'fourViewsPerVariant':True,'testDates':sorted(test_dates),'testTimeZone':'Australia/Sydney','superSplatViewerSortedOnly':True,'allSortedCasesRadial':True,'motionAmplitudeDegrees':45,'browsers':sorted(browser),'physicalResolution':[list(r) for r in resolutions],'dpr':2,'consoleErrors':0,'unknownGpuFormats':0,'sparkExtendedSourceAndAccumulator':True,'sparkDefaultLodWithoutHierarchy':True,'cameraMatchesConfig':True,'gslWebGPUViewerColorSpace':'srgb','frameMetric':'Frame Completion P50 and P95','memoryMetric':'JS heap + ArrayBuffer/external backing + Worker WASM accounting sum; explicit GPU allocation separate','complete':actual==expected}
summary['interleavedExecutionOrderVerified']='--partial' not in sys.argv
summary['radixSortSupplementRuns']=len(sort_execution)
summary['radixDefaultSortBits']=24
print(json.dumps(summary,ensure_ascii=False,indent=2))
if '--partial' not in sys.argv:
 filename='validation'+('-'+'-'.join(models) if len(models)<len(counts) else '')+('-single' if '--single' in sys.argv else '')+'.json'
 (ROOT/'outputs'/filename).write_text(json.dumps(summary,ensure_ascii=False,indent=2))
