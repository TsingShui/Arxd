// Install native platform APIs before any route imports portable Agent modules.
import './src/runtime';
import './src/background/register';
import 'expo-router/entry';
