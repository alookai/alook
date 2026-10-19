import json
import pathlib
import shutil
import subprocess
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]


class PreviewRoutes(unittest.TestCase):
    def test_actual_preview_cancel_and_setup_boundaries(self):
        node = shutil.which('node')
        self.assertIsNotNone(node)
        template = (ROOT / 'preview/template.html').read_text()
        script = template.split('<script>', 1)[1].split('</script>', 1)[0]
        scenes = {name: name for name in ['dm-human', 'dm-home', 'settings', 'logout', 'network', 'dm-human-chat', 'dm-human-recording', 'authorization-empty']}
        script = script.replace('__SCENES__', json.dumps(scenes)).replace('__CONTROLS__', '{}')
        harness = r'''
const assert=require('node:assert/strict'),elements=new Map();
function element(){return {style:{},listeners:{},textContent:'',replaceChildren(){},append(){},setAttribute(){},addEventListener(name,fn){this.listeners[name]=fn},setPointerCapture(){}}}
const document={getElementById(id){if(!elements.has(id))elements.set(id,element());return elements.get(id)},createElement:element};
'''
        harness += script + r'''
act({action:'Logout'});assert.equal(current,'logout');
act({action:'Back'});assert.equal(current,'settings');assert.equal(selected,true);
show('network');boot.listeners.pointerdown({preventDefault(){},pointerId:1});
assert.equal(current,'network');assert.equal(holding,false);assert.equal($('toast').textContent,'Finish Wi-Fi setup before recording.');
act({action:'Back'});assert.equal(current,'settings');
show('network');pwr();assert.equal(current,'settings');
show('dm-human-chat');act({action:'Back'});assert.equal(current,'dm-human');
act({action:'Logout'});act({action:'ConfirmLogout'});assert.equal(current,'authorization-empty');assert.equal(selected,false);
'''
        subprocess.run([node, '-e', harness], check=True)


if __name__ == '__main__':
    unittest.main()
