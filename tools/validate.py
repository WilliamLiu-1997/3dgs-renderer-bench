from pathlib import Path
import json, math, sys

ROOT=Path(__file__).resolve().parent.parent
R=ROOT/'harness/results'
counts={'elevator':2796503,'hotel':12202010}
config=json.loads((ROOT/'harness/config.json').read_text())
expected_cases={'spark':3,'supersplat':7,'gsl-gl':10,'gsl-gpu':10}
models=['hotel'] if '--hotel' in sys.argv else counts
round_count=1 if '--single' in sys.argv else 3
expected={f'{model}-{mode}-r{round}' for model in models for mode in expected_cases for round in range(1,round_count+1)}
actual={f.stem for f in R.glob('*.json')}
if '--hotel' in sys.argv:actual={name for name in actual if name.startswith('hotel-')}
if '--partial' not in sys.argv:
 assert actual==expected, f'Missing: {expected-actual}; extra: {actual-expected}'
frames=0;groups=0;sort_groups=0;browser=set();resolutions=set()
gsl_defaults={'minPixelRadius':1,'maxPixelRadius':256,'preBlurAmount':.3,'blurAmount':0,'clipXY':1.25,'focalAdjustment':2}
spark_defaults={'minPixelRadius':0,'maxPixelRadius':512,'preBlurAmount':0,'blurAmount':.3,'clipXY':1.4,'focalAdjustment':1}
for name in sorted(actual):
 d=json.loads((R/(name+'.json')).read_text());mode=d['mode'];initial=d['initial']
 assert not d.get('failure'), (name,d.get('failure'))
 assert not d['consoleErrors'],(name,d['consoleErrors'])
 assert initial['resolution']==[3024,1964] and initial['dpr']==2,name
 assert initial['state']['sourceCount']==counts[d['model']],name
 assert initial['state']['sh']==3,name
 assert d['config']['protocol']==config['protocol'],name
 expected_parameters=spark_defaults if mode=='spark' else gsl_defaults if mode.startswith('gsl') else {'minPixelSize':2,'motionBudgetMs':12,'occlusionCull':True}
 assert all(initial['state']['renderParameters'][k]==v for k,v in expected_parameters.items()),name
 assert initial['state']['sortRadial'] is False,name
 if mode.startswith('gsl'):assert initial['state']['reversedDepthBuffer'] is True,name
 camera=config['models'][d['model']]
 assert initial['camera']['position']==[a+b for a,b in zip(camera['target'],camera['offset'])],name
 assert len(d['cases'])==expected_cases[mode],name
 assert len(d['sort'])==(2 if mode.startswith('gsl') else 1),name
 if mode=='spark':
  assert 'ExtSplats' in initial['state']['sourceType'] and initial['state']['accumulatorExtended'],name
  assert initial['state']['lodEnabled'] is True and initial['state']['hasLodData'] is False,name
 if mode=='gsl-gpu':
  assert initial['state']['workingColorSpace']=='srgb' and initial['state']['outputColorSpace']=='srgb',name
  assert initial['state']['deviceConfiguration']=='three-default',name
  assert 'timestamp-query' in initial['state']['deviceFeatures'],name
  assert initial['state']['compatibilityMode']==('core-features-and-limits' not in initial['state']['deviceFeatures']),name
 if mode=='supersplat':
  assert initial['state']['stochasticTarget']=='rgba8unorm' and initial['state']['sortedTarget']=='rgba16float',name
  assert initial['state']['stochasticFilter']=='linear' and initial['state']['stochasticResolveTarget']=='rgba16float',name
 for c in d['cases']:
  assert c['variant'] in ['sorted','stochastic','stochastic-resolved'],name
  assert not c['errors'],name
  assert not c['memory']['unknownFormats'],(name,c['memory']['unknownFormats'])
  assert c['warm']['frames']>=20 and c['warm']['ms']>=1000,name
  assert len(c['rows'])>=(64 if c['variant']=='sorted' else 48),name
  assert all(math.isfinite(r['gpuMs']) and r['gpuMs']>0 for r in c['rows']),name
  assert c['memory']['gpuBytes']>0 and c['heap']['usedSize']>0,name
  assert c['heap']['backingStorageSize']>=0,name
  assert c['state']['stochastic']==c['variant'].startswith('stochastic'),name
  assert c['state']['sortRadial'] is False,name
  assert all(c['state']['renderParameters'][k]==v for k,v in expected_parameters.items()),name
  if mode=='gsl-gpu' and c['variant']=='stochastic-resolved':
   assert c['state']['spatialResolve'] and c['state']['temporalResolve'] is False,name
  if mode=='supersplat' and c['variant'].startswith('stochastic'):
   assert c['warm']['ms']>=6000 and c['state']['stats']['occlusionActive'] is True,name
  if mode.startswith('gsl'):
   assert c['state']['fastSort']==c['fast'],name
   if mode=='gsl-gpu':assert c['state']['sortBits']==(24 if c['fast'] else 32),name
  frames+=len(c['rows']);groups+=1
 for s in d['sort']:
  assert len(s['rows'])==16,name
  for row in s['rows']:
   if mode in ['spark','gsl-gl']:
    calls=[r for r in row['rpc'] if r['name'].startswith('sort')]
    assert calls and all(r['workerMs']>0 for r in calls),name
    assert row['sortJobs'] and all(j['ms']>0 for j in row['sortJobs']),name
   else:
    passes=[p for p in row['passes'] if p['stage']=='sort']
    assert passes and all(p['end']>p['start'] for p in passes),name
  sort_groups+=1
 browser.add(d['browser']);resolutions.add(tuple(initial['resolution']))
summary={'runs':len(actual),'performanceGroups':groups,'measuredFrames':frames,'sortGroups':sort_groups,'sortSamples':16*sort_groups,'nativeRendererDefaults':True,'allSortRadialFalse':True,'browsers':sorted(browser),'physicalResolution':[list(r) for r in resolutions],'dpr':2,'consoleErrors':0,'unknownGpuFormats':0,'sparkExtendedSourceAndAccumulator':True,'sparkDefaultLodWithoutHierarchy':True,'supersplatNativeStochasticDefaults':True,'cameraMatchesConfig':True,'gslWebGPUViewerColorSpace':'srgb','gslWebGPUSpatialResolveTemporalEnabled':False,'memoryMetric':'Main-thread JS heap after GC; external storage and Worker WASM capacity separate','supersplatNativeTargetFormats':True,'complete':actual==expected}
print(json.dumps(summary,ensure_ascii=False,indent=2))
if '--partial' not in sys.argv:
 filename='validation'+('-hotel' if '--hotel' in sys.argv else '')+('-single' if '--single' in sys.argv else '')+'.json'
 (ROOT/'outputs'/filename).write_text(json.dumps(summary,ensure_ascii=False,indent=2))
