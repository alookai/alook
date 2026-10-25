import React from 'react';
import {Composition,registerRoot} from 'remotion';
import {NewBot} from './video';
import timing from './timing.json';
import './product.css';
import './style.css';
registerRoot(()=> <Composition id="NewBot" component={NewBot} width={1920} height={1080} fps={timing.fps} durationInFrames={timing.duration+timing.dialogHold}/>);
