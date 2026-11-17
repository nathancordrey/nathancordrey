import io
import json
import os
import sqlite3
import tempfile
import unittest
import zipfile
from pathlib import Path
from flask import Flask
from werkzeug.security import generate_password_hash
from PIL import Image
from art import art, make_backup

class ArtTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        os.environ['ART_DATA_DIR']=self.tmp.name
        os.environ['ART_PASSWORD_HASH']=generate_password_hash('family-test')
        self.app=Flask(__name__,template_folder='../templates',static_folder='../static')
        self.app.secret_key='test-secret'
        self.app.register_blueprint(art)
        self.client=self.app.test_client()
        self.client.get('/art/login')
        with self.client.session_transaction() as s: token=s['art_csrf']
        self.assertEqual(self.client.post('/art/login',data={'password':'family-test','csrf':token}).status_code,302)
        with self.client.session_transaction() as s: self.headers={'X-CSRF-Token':s['art_csrf']}
    def tearDown(self): self.tmp.cleanup()
    def test_auth_and_csrf(self):
        other=self.app.test_client()
        self.assertEqual(other.get('/art/api/notebook').status_code,401)
        self.assertEqual(other.get('/art/photo/anything/original').status_code,302)
        self.assertEqual(self.client.put('/art/api/notebook',json={}).status_code,403)
        self.assertEqual(self.client.get('/art/').status_code,200)
    def test_conflict_and_validation(self):
        body={k:[] for k in ('sessions','profiles','prompts','journal','plans','materials','artworks','trash')}
        self.assertEqual(self.client.put('/art/api/notebook',json={'revision':0,'data':body},headers=self.headers).status_code,200)
        self.assertEqual(self.client.put('/art/api/notebook',json={'revision':0,'data':body},headers=self.headers).status_code,409)
        self.assertEqual(self.client.get('/art/api/notebook').json['revision'],1)
        self.assertEqual(self.client.put('/art/api/notebook',json={'revision':1,'data':{}},headers=self.headers).status_code,400)
    def test_upload_and_restore(self):
        image=io.BytesIO();Image.new('RGB',(50,80),'green').save(image,'PNG');raw=image.getvalue()
        result=self.client.post('/art/api/photos',data={'photo':(io.BytesIO(raw),'drawing.png')},headers=self.headers)
        self.assertEqual(result.status_code,200)
        ident=result.json['id']
        with self.client.get(f'/art/photo/{ident}/original') as response:
            self.assertEqual(response.data,raw)
        with self.client.get(f'/art/photo/{ident}/preview') as response:
            self.assertEqual(response.status_code,200)
        self.assertEqual(self.client.post('/art/api/photos',data={'photo':(io.BytesIO(b'not an image'),'fake.jpg')},headers=self.headers).status_code,400)
        output=io.BytesIO()
        make_backup(output)
        with tempfile.TemporaryDirectory() as restored:
            with zipfile.ZipFile(output) as z: z.extractall(restored)
            with sqlite3.connect(Path(restored)/'notebook.sqlite3') as db:
                self.assertEqual(db.execute('SELECT id FROM uploads').fetchone()[0],ident)
            self.assertEqual((Path(restored)/'uploads'/f'{ident}.png').read_bytes(),raw)
        with self.client.get('/art/export') as response:
            self.assertEqual(response.status_code,200)

if __name__=='__main__': unittest.main()
