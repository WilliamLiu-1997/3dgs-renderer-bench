from pathlib import Path
import json, math, sys

ROOT=Path(__file__).resolve().parent.parent
R=ROOT/'harness/results'
counts={'elevator':2796503,'hotel':12202010}
config=json.loads((ROOT/'harness/config.json').read_text())
expected_cases={'spark':3,'pc-gl':3,'pc-gpu':5,'supersplat':7,'gsl-gl':7,'gsl-gpu':7}
models=['hotel'] if '--hotel' in sys.argv else counts
round_count=1 if '--single' in sys.argv else 3
expected={f'{model}-{mode}-r{round}' for model in models for mode in expected_cases for round in range(1,round_count+1)}
actual={f.stem for f in R.glob('*.json') if not f.name.startswith('._')}
if '--hotel' in sys.argv:actual={name for name in actual if name.startswith('hotel-')}
if '--partial' not in sys.argv:
 assert actual==expected, f'Missing: {expected-actual}; extra: {actual-expected}'
frames=0;groups=0;sort_groups=0;browser=set();resolutions=set()
gsl_defaults={'minPixelRadius':1,'maxPixelRadius':256,'preBlurAmount':.3,'blurAmount':0,'clipXY':1.25,'focalAdjustment':2,'minAlpha':1/255}
spark_defaults={'minPixelRadius':2,'maxPixelRadius':512,'preBlurAmount':.3,'blurAmount':0,'clipXY':1.25,'focalAdjustment':2,'minAlpha':1/255}
for name in sorted(actual):
 d=json.loads((R/(name+'.json')).read_text());mode=d['mode'];initial=d['initial']
 assert not d.get('failure'), (name,d.get('failure'))
 assert not d['consoleErrors'],(name,d['consoleErrors'])
 assert initial['resolution']==[3024,1964] and initial['dpr']==2,name
 assert initial['state']['sourceCount']==counts[d['model']],name
 assert initial['state']['sh']==3,name
 assert d['config']['protocol']==config['protocol'],name
 assert d['config']['versions']==config['versions'],name
 expected_parameters=spark_defaults if mode=='spark' else gsl_defaults if mode.startswith('gsl') else {'minPixelSize':2,'minContribution':0,'occlusionCull':True,'temporalResolve':False,'warpStrength':0} if mode=='supersplat' else {'minPixelSize':2,'minContribution':0,'alphaClipForward':1/255,'antiAlias':False,'colorUpdateAngle':0,'radialSorting':False,'dataFormat':'large'}
 assert all(initial['state']['renderParameters'][k]==v for k,v in expected_parameters.items()),name
 assert initial['state']['sortRadial'] is False,name
 if mode.startswith('gsl'):assert initial['state']['reversedDepthBuffer'] is True,name
 camera=config['models'][d['model']]
 assert initial['camera']['position']==[a+b for a,b in zip(camera['target'],camera['offset'])],name
 assert len(d['cases'])==expected_cases[mode],name
 assert len(d['sort'])==1,name
 if mode=='spark':
  assert 'ExtSplats' in initial['state']['sourceType'] and initial['state']['accumulatorExtended'],name
  assert initial['state']['lodEnabled'] is True and initial['state']['hasLodData'] is False,name
 if mode=='gsl-gpu':
  assert initial['state']['workingColorSpace']=='srgb' and initial['state']['outputColorSpace']=='srgb',name
  assert initial['state']['deviceConfiguration']=='three-default',name
  assert 'timestamp-query' in initial['state']['deviceFeatures'],name
  assert initial['state']['compatibilityMode']==('core-features-and-limits' not in initial['state']['deviceFeatures']),name
 expected_scenarios={('sorted',False,0),('sorted',False,.55),('sorted',True,0)}
 if mode.startswith('gsl') or mode in ['pc-gpu','supersplat']:expected_scenarios|={('stochastic',False,0),('stochastic',True,0)}
 if mode.startswith('gsl') or mode=='supersplat':expected_scenarios|={('stochastic-resolved',False,0),('stochastic-resolved',True,0)}
 assert {(c['variant'],c['moving'],c['angle']) for c in d['cases']}==expected_scenarios,name
 for c in d['cases']:
  assert c['motionAmplitudeDegrees']==(45 if c['moving'] else 0),name
  if c['moving']:
   angles=[r['cameraAngle'] for r in c['rows']]
   assert abs(min(angles)-(c['angle']-math.pi/4))<1e-12 and abs(max(angles)-(c['angle']+math.pi/4))<1e-12,name
  assert c['variant'] in ['sorted','stochastic','stochastic-resolved'],name
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
  assert c['state']['sortRadial'] is False,name
  assert all(c['state']['renderParameters'][k]==v for k,v in expected_parameters.items()),name
  if mode=='gsl-gpu' and c['variant']=='stochastic-resolved':
   assert c['state']['spatialResolve'] and c['state']['temporalResolve'] is False,name
  if mode=='pc-gpu' and c['variant']=='stochastic':
   assert c['state']['sorting']=='none' and c['state']['dither']=='bluenoise',name
   assert c['state']['spatialResolve'] is False and c['state']['temporalResolve'] is False,name
   assert all(not any(p['stage']=='sort' for p in r['passes']) for r in c['rows']),name
  if mode=='supersplat':
   assert c['state']['backend']=='webgpu' and c['state']['sortBits']==20,name
   assert c['state']['spatialResolve']==(c['variant']=='stochastic-resolved') and c['state']['temporalResolve'] is False,name
   if c['state']['stochastic']:
    assert c['state']['sorting']=='none' and c['state']['stats']['motionContribution']==0,name
    assert c['state']['stats']['occlusionActive'] is True,name
    assert all(not any(p['stage']=='sort' for p in r['passes']) for r in c['rows']),name
  if mode.startswith('gsl'):
   assert c['state']['fastSort'] is True and c['fast'] is True,name
   if mode=='gsl-gpu':assert c['state']['sortBits']==24,name
  frames+=len(c['rows']);groups+=1
 for s in d['sort']:
  if mode.startswith('gsl'):assert s['fast'] is True,name
  assert len(s['rows'])==16,name
  for row in s['rows']:
   if mode in ['spark','gsl-gl','pc-gl']:
    calls=[r for r in row['rpc'] if r['name'].startswith('sort')]
    assert calls and all(r['workerMs']>0 for r in calls),name
    assert row['sortJobs'] and all(j['ms']>0 for j in row['sortJobs']),name
   else:
    passes=[p for p in row['passes'] if p['stage']=='sort']
    assert passes and all(p['end']>p['start'] for p in passes),name
  sort_groups+=1
 browser.add(d['browser']);resolutions.add(tuple(initial['resolution']))
summary={'runs':len(actual),'performanceGroups':groups,'measuredFrames':frames,'sortGroups':sort_groups,'sortSamples':16*sort_groups,'renderingSettingsAdjustedAsCloselyAsPossible':True,'gslDefaultSortOnly':True,'playcanvasWebGPUStochastic':True,'supersplatEditorStochasticAndSpatialResolve':True,'supersplatNativeDepthOcclusion':True,'allSortRadialFalse':True,'motionAmplitudeDegrees':45,'browsers':sorted(browser),'physicalResolution':[list(r) for r in resolutions],'dpr':2,'consoleErrors':0,'unknownGpuFormats':0,'sparkExtendedSourceAndAccumulator':True,'sparkDefaultLodWithoutHierarchy':True,'cameraMatchesConfig':True,'gslWebGPUViewerColorSpace':'srgb','gslWebGPUSpatialResolveTemporalEnabled':False,'frameMetric':'Frame Completion P50 and P95','memoryMetric':'JS heap + ArrayBuffer/external backing + Worker WASM accounting sum; explicit GPU allocation separate','complete':actual==expected}
print(json.dumps(summary,ensure_ascii=False,indent=2))
if '--partial' not in sys.argv:
 filename='validation'+('-hotel' if '--hotel' in sys.argv else '')+('-single' if '--single' in sys.argv else '')+'.json'
 (ROOT/'outputs'/filename).write_text(json.dumps(summary,ensure_ascii=False,indent=2))
