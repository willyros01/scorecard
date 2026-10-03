"""Exercise iv0 apply/verify/rollback with isolated stand-ins for Google."""
import os, pathlib, tempfile, subprocess, json
ROOT = pathlib.Path(__file__).resolve().parents[2]
FAKE_CURL = r'''#!/usr/bin/env python3
import sys, os, json, pathlib
a=sys.argv[1:]; state=pathlib.Path(os.environ['PROBE_STATE']); root=pathlib.Path(os.environ['PROBE_ROOT'])
url=next(x for x in a if x.startswith('https://')); method=a[a.index('-X')+1] if '-X' in a else 'GET'
output=a[a.index('-o')+1] if '-o' in a else None
body=json.loads(pathlib.Path(a[a.index('--data-binary')+1].lstrip('@')).read_text()) if '--data-binary' in a else None
s=json.loads((state/'state.json').read_text()); status=200; result={}
def fault(name):
 if s.get('fault')==name: s['fault']=''; return True
 return False
if 'raw.githubusercontent.com' in url:
 if s.get('fault')=='github': sys.exit(22)
 if url.endswith('query-indexes.json'): result=(root/'build/query-indexes.json').read_text()
 else: result=s['old'] if '/1036ab02e7a0e64e029c069708f2242608e08992/' in url else (root/'firestore.rules').read_text()
elif ':runQuery' in url:
 if fault('index'): status=400; result={'error':{'message':'Missing index'}}
 else: result=[{'readTime':'2026-10-03T00:00:00Z'}]
elif url.endswith('/settings/invitationLinks'):
 if method=='GET':
  if s['marker'] is None: status=404; result={'error':{'message':'Not found'}}
  else: result={'fields':s['marker']}
 elif method=='DELETE': s['marker']=None; status=204; result=''
 elif fault('marker'): status=500; result={'error':{'message':'Marker refused'}}
 else: s['marker']=body['fields']; result={'fields':s['marker']}
elif '/releases/cloud.firestore' in url:
 if method=='GET': result={'rulesetName':'projects/scorecard-f41b8/rulesets/'+s['release']}
 elif fault('publish'): status=500; result={'error':{'message':'Publication refused'}}
 else: s['release']=body['release']['rulesetName'].split('/')[-1]; result={}
elif '/rulesets/' in url:
 name=url.split('/')[-1]; result={'source':{'files':[{'name':'firestore.rules','content':s['rulesets'][name]}]}}
elif url.endswith('/rulesets'):
 name='r'+str(len(s['rulesets'])); s['rulesets'][name]=body['source']['files'][0]['content']; result={'name':'projects/scorecard-f41b8/rulesets/'+name}
else: status=404; result={'error':{'message':'Unexpected request '+url}}
(state/'state.json').write_text(json.dumps(s))
text=result if isinstance(result,str) else json.dumps(result)
if output:
 if output!='/dev/null': pathlib.Path(output).write_text(text)
else: sys.stdout.write(text)
if '-w' in a: sys.stdout.write(str(status))
if status>=400 and any(x in a for x in ['--fail','--fail-with-body']): sys.exit(22)
'''
FAKE_GCLOUD = '''#!/usr/bin/env python3
import sys
a=sys.argv[1:]
if a[:3]==['config','set','project']: pass
elif a[:2]==['config','get-value']: print('scorecard-f41b8')
elif a[:2]==['projects','describe']: print('scorecard-f41b8')
elif a[:2]==['auth','list']: print('tester@example.invalid')
elif a[:2]==['auth','print-access-token']: print('fake-test-token')
else: sys.exit(1)
'''
passed=0
def check(label, fn):
 global passed
 fn(); passed+=1; print('PASS '+label)
with tempfile.TemporaryDirectory() as temp:
 base=pathlib.Path(temp); binaries=base/'bin'; binaries.mkdir()
 for name, content in [('curl',FAKE_CURL),('gcloud',FAKE_GCLOUD),('sleep','#!/bin/sh\nexit 0\n')]:
  p=binaries/name; p.write_text(content); p.chmod(0o755)
 env={**os.environ,'PATH':str(binaries)+':'+os.environ['PATH'],'PROBE_STATE':str(base),'PROBE_ROOT':str(ROOT)}
 old="rules_version = '2'; /* previous beta.9 */"
 def reset(fault=''):
  import shutil
  shutil.rmtree(base/'scorecard-iv0-backup',ignore_errors=True)
  (base/'state.json').write_text(json.dumps({'old':old,'release':'r0','rulesets':{'r0':old},'marker':None,'fault':fault}))
 def state(): return json.loads((base/'state.json').read_text())
 def run(mode='', answer='yes'):
  return subprocess.run(['bash',str(ROOT/'build/iv0.txt')]+([mode] if mode else []),input=answer+'\n',text=True,capture_output=True,env=env,cwd=base)
 def success(result):
  assert result.returncode==0, result.stdout+result.stderr
 def restored():
  s=state(); assert s['rulesets'][s['release']].rstrip()==old.rstrip() and s['marker'] is None, 'Previous state was not restored'
 reset(); success(run()); assert state()['marker']['version']['integerValue']=='2'; check('deployment activates tested rules and marker',lambda: None)
 success(run('verify')); check('verify checks rules, marker and all live query probes',lambda: None)
 before=state(); success(run()); assert state()==before; check('repeated apply changes nothing',lambda: None)
 success(run('rollback')); restored(); check('rollback restores rules and absent marker',lambda: None)
 reset(); s=state(); s['marker']={'version':{'integerValue':'1'},'note':{'stringValue':'preserve'}}; (base/'state.json').write_text(json.dumps(s)); success(run()); s=state(); s['fault']='github'; (base/'state.json').write_text(json.dumps(s)); success(run('rollback')); assert state()['marker']=={'version':{'integerValue':'1'},'note':{'stringValue':'preserve'}}; check('rollback restores an existing marker without GitHub access',lambda: None)
 reset(); success(run()); backup=(base/'scorecard-iv0-backup/rules-before.txt').read_text(); s=state(); s['marker']=None; (base/'state.json').write_text(json.dumps(s)); assert run().returncode!=0; assert (base/'scorecard-iv0-backup/rules-before.txt').read_text()==backup; success(run('rollback')); restored(); check('unexpected current state cannot overwrite the rollback backup',lambda: None)
 reset(); result=run(answer='no'); assert result.returncode!=0; restored(); check('declining publication changes nothing',lambda: None)
 for fault in ['index','publish','marker']:
  reset(fault); result=run(); assert result.returncode!=0, result.stdout; restored(); check(fault+' failure preserves or restores previous state',lambda: None)
 reset(); s=state(); s['rulesets']['r0']='unexpected rules'; (base/'state.json').write_text(json.dumps(s)); result=run(); assert result.returncode!=0 and state()['release']=='r0'; check('unexpected prior rules refused',lambda: None)
print(f'RESULT: {passed} deployment checks passed')
