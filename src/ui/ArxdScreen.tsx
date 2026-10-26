import { requireVerification } from '../verification/access';
import { MotionModal } from './MotionModal';
import { BusyIndicator } from './BusyIndicator';
import { useTheme } from './appearance';
import { router, useLocalSearchParams, useNavigation, usePathname, type NativeStackNavigationProp } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import * as DocumentPicker from 'expo-document-picker';
import * as SecureStore from 'expo-secure-store';
import * as Sharing from 'expo-sharing';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Alert, Animated, BackHandler, Easing, Image, Keyboard, KeyboardAvoidingView, PanResponder, Pressable, ScrollView, Share, StyleSheet, Text, TextInput, useWindowDimensions, View, type LayoutChangeEvent, type ScrollViewInstance, type StyleProp, type TextInputInstance, type ViewStyle } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';
import Rxd, { type WorkspaceFile } from '../../modules/rxd';
import { MAX_IMPORT_BYTES, MAX_MESSAGE_CHARS } from '../workspace/limits.ts';
import { SAMPLE_SOURCE } from '../agent/offline-provider';
import { getAndroidWorkspace } from '../workspace/android';
import type { ModelThinkingLevel } from '@earendil-works/pi-ai';
import type { Artifact, ModelMode, ToolView, TurnView, Workspace, WorkspaceSnapshot } from '../workspace/core';
import { Icon, type IconName } from './Icon';
import { Mark } from './Mark';
import { contextLabel, contextTone } from '../workspace/models';
import { CompactionRequests } from './CompactionRequests';
import { CodeBlock } from './CodeText';
import { languageForFile } from './highlight';
import { ResponseActivity } from './ResponseActivity';
import { ContextCapacity } from './ContextCapacity';
import { RichText } from './RichText';
import { reportUiStage } from '../verification/report';
import { runUiAction, reportStreamSample, reportActivitySample } from '../verification/ui-actions';
import { useI18n } from '../i18n/index.ts';
import { type } from './type';
import { shade, motion, type Colors } from './theme';
import { toolLabel } from './tool-label';

type MainRouteParams = { action?: string; requestId?: string; prompt?: string; composeId?: string; attachmentId?: string };
type Detail = { kind: 'file'; file: WorkspaceFile } | { kind: 'artifact'; artifact: Artifact } | { kind: 'tool'; tool: ToolView; file: WorkspaceFile | null; record?: object };
type LocalProfile = { name: string; avatar?: { uri: string; sha256: string } };
type ProfileDraft = LocalProfile & { pending?: { uri: string; name: string } };
// An empty name means "use the localized default", so the greeting follows the UI
// language instead of freezing whatever was shown the first time.
const DEFAULT_PROFILE: LocalProfile = { name: '' };
const LEGACY_DEFAULT_NAME = '陌生人';
const PROFILE_KEY = 'arxd.local-profile.v1';
function LocalAvatar({ name, uri, c, size = 40 }: { name: string; uri?: string; c: Colors; size?: number }) {
  return <View style={{ width: size, height: size, borderRadius: size / 2, overflow: 'hidden', backgroundColor: c.raised, borderWidth: 1, borderColor: c.line, alignItems: 'center', justifyContent: 'center' }}>
    {uri ? <Image source={{ uri }} resizeMode="cover" style={{ width: size, height: size }} /> : <Text style={{ ...type.list, color: c.heading, fontSize: size * .38, fontWeight: '600' }}>{(name.trim() || '?').slice(0, 1)}</Text>}
  </View>;
}
const fileSize = (n: number) => n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;



/** Fades and lifts a block once, on mount, so only new turns animate. */
function FadeIn({ style, children, pointerEvents, onLayout }: { style?: StyleProp<ViewStyle>; children: ReactNode; pointerEvents?: 'none'; onLayout?: (event: LayoutChangeEvent) => void }) {
  const { reducedMotion } = useTheme();
  const [value] = useState(() => new Animated.Value(0));
  useEffect(() => {
    const animation = Animated.timing(value, { toValue: 1, duration: reducedMotion ? 0 : motion.content, easing: Easing.out(Easing.quad), useNativeDriver: true }); animation.start(); return () => animation.stop();
  }, [value, reducedMotion]);
  return <Animated.View onLayout={onLayout} pointerEvents={pointerEvents} style={[style, { opacity: value, transform: [{ translateY: value.interpolate({ inputRange: [0, 1], outputRange: [9, 0] }) }] }]}>{children}</Animated.View>;
}

/** Breathing caret shown while an answer is still streaming. */
function LiveCaret({ color }: { color: string }) {
  const { reducedMotion } = useTheme();
  const [value] = useState(() => new Animated.Value(1));
  useEffect(() => {
    if (reducedMotion) { value.setValue(1); return; }
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(value, { toValue: .18, duration: 620, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      Animated.timing(value, { toValue: 1, duration: 620, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [value, reducedMotion]);
  return <Animated.View style={[s.caret, { backgroundColor: color, opacity: value }]} />;
}

/** Gemini-style drawer row: icon, label, optional badge for reserved entries. */
function DrawerRow({ icon, label, badge, onPress, c }: { icon: IconName; label: string; badge?: string; onPress?: () => void; c: Colors }) {
  const content = <>
    <Icon name={icon} color={onPress ? c.text : c.faint} size={24} />
    <Text style={[s.drawerRowLabel, { color: onPress ? c.text : c.faint }]}>{label}</Text>
    {badge ? <Text style={[s.drawerBadge, { color: c.quiet, borderColor: c.line }]}>{badge}</Text> : null}
  </>;
  if (!onPress) return <View accessible accessibilityLabel={label} style={s.drawerRow}>{content}</View>;
  return <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={({ pressed }) => [s.drawerRow, pressed && { opacity: .55 }]}>{content}</Pressable>;
}

export default function ArxdScreen() {
  const { t } = useI18n();
  const navigation = useNavigation<NativeStackNavigationProp<{ index: MainRouteParams }, 'index'>>();
  const params = useLocalSearchParams<MainRouteParams>();
  const [workspace, setWorkspace] = useState<Workspace>();
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot>();
  const importLimit = () => snapshot?.importLimit ?? MAX_IMPORT_BYTES;
  const importLimitLabel = () => { const mib = Math.round(importLimit() / 1048576); return mib >= 1024 && mib % 1024 === 0 ? `${mib / 1024} GiB` : `${mib} MiB`; };
  const [draft, setDraft] = useState('');
  const [appliedComposeId, setAppliedComposeId] = useState<string>();
  if (typeof params.prompt === 'string' && typeof params.composeId === 'string' && appliedComposeId !== params.composeId) {
    setAppliedComposeId(params.composeId);
    const prompt = params.prompt.slice(0, 1000);
    setDraft((current) => current.trim() ? params.attachmentId ? current : `${current}\n\n${prompt}` : prompt);
  }
  const [pending, setPending] = useState<WorkspaceFile | null>(null);
  const [inlineEdit, setInlineEdit] = useState<{ turnId: string; fileId: string; file: WorkspaceFile | null; text: string }>();
  const [appliedAttachmentId, setAppliedAttachmentId] = useState<string>();
  if (params.attachmentId && params.composeId && appliedAttachmentId !== params.composeId) {
    const file = snapshot?.files.find((file) => file.id === params.attachmentId);
    if (file) { setAppliedAttachmentId(params.composeId); setPending(file); }
  }
  const [drawer, setDrawer] = useState(false);
  const [profile, setProfile] = useState<LocalProfile>(DEFAULT_PROFILE);
  const [profileOpen, setProfileOpen] = useState(false);
  const [profileDraft, setProfileDraft] = useState<ProfileDraft>();
  const [profileError, setProfileError] = useState('');
  const [profileBusy, setProfileBusy] = useState(false);
  // Mounted but inert while a swipe drags it in, so the fresh scrim cannot swallow
  // the finger-up that decides the open.
  const [drawerLive, setDrawerLive] = useState(false);
  const [modelAnim] = useState(() => new Animated.Value(0));
  const [modelMenu, setModelMenu] = useState(false);
  const [modelMounted, setModelMounted] = useState(false);
  const [quickMenu, setQuickMenu] = useState(false);
  const [quickMounted, setQuickMounted] = useState(false);
  const [quickAnim] = useState(() => new Animated.Value(0));
  const [sheet, setSheet] = useState<'import' | 'files' | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [tab, setTab] = useState<'preview' | 'raw'>('preview');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [working, setWorking] = useState(false);
  const [savingArtifact, setSavingArtifact] = useState(false);
  const [savedArtifactId, setSavedArtifactId] = useState<string>();
  const streamSamples = useRef(new Set<number>());
  const [inputHeight, setInputHeight] = useState(44);
  const sending = useRef(false);
  const actionStarted = useRef<string | undefined>(undefined);
  const scroll = useRef<ScrollViewInstance>(null);
  const followOutput = useRef(true);
  const turnOffsets = useRef<Record<string, number>>({});
  const input = useRef<TextInputInstance>(null);
  const { c, reducedMotion } = useTheme();
  const path = usePathname();
  const busy = !!snapshot?.busy;
  const anotherBusy = snapshot?.conversations.find((s) => s.busy && s.id !== snapshot.active);
  const uiAction = typeof params.action === 'string' && params.action.startsWith('ui-') ? params.action : undefined;
  const uiRequest = uiAction ? `${uiAction}/${typeof params.requestId === 'string' ? params.requestId : 'initial'}` : undefined;
  const { width: screenWidth } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [headerHeight, setHeaderHeight] = useState(64);
  // The drawer owns the whole window; the slide still shows the thread behind it.
  const drawerWidth = Math.min(360, Math.round(screenWidth * .84));
  const drawerClosedX = -drawerWidth - 12;
  const [drawerX] = useState(() => new Animated.Value(-drawerWidth - 12));
  useEffect(() => {
    let live = true;
    void SecureStore.getItemAsync(PROFILE_KEY).then((raw) => {
      if (!live || !raw) return;
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
      const value = parsed as { name?: unknown; avatar?: { uri?: unknown; sha256?: unknown } };
      // Older builds stored the Chinese default as a real name; treat it as unset.
      const stored = typeof value.name === 'string' && value.name.trim() ? value.name.trim().slice(0, 40) : '';
      const name = stored === LEGACY_DEFAULT_NAME ? '' : stored;
      const avatar = value.avatar && typeof value.avatar.uri === 'string' && typeof value.avatar.sha256 === 'string' ? { uri: value.avatar.uri, sha256: value.avatar.sha256 } : undefined;
      setProfile({ name, ...(avatar ? { avatar } : {}) });
    }).catch(() => undefined);
    return () => { live = false; };
  }, []);
  // Settling continues the finger's motion: a spring seeded with the release
  // velocity, so the panel never stops dead between the drag and the animation.
  const settle = useCallback((toValue: number, velocity: number, onDone?: () => void) => {
    drawerX.stopAnimation();
    if (reducedMotion) { drawerX.setValue(toValue); onDone?.(); return; }
    Animated.spring(drawerX, { toValue, velocity, damping: 26, stiffness: 260, mass: 0.85, overshootClamping: true, useNativeDriver: true })
      .start(({ finished }) => { if (finished) onDone?.(); });
  }, [drawerX, reducedMotion]);
  const openDrawer = useCallback(() => {
    setDrawer(true);
    setDrawerLive(true);
    settle(0, 0);
  }, [settle]);
  const closeDrawer = useCallback((velocity = 0) => {
    // Interactivity is dropped only when the panel is gone, so the closing frame
    // never re-renders the whole drawer mid-animation.
    settle(drawerClosedX, velocity, () => { setDrawer(false); setDrawerLive(false); });
  }, [settle, drawerClosedX]);
  const dismissDrawer = useCallback(() => {
    // A route owns the next transition. Sliding the drawer out at the same time
    // would read as two page turns (drawer close + stack push).
    drawerX.stopAnimation();
    drawerX.setValue(drawerClosedX);
    setDrawer(false);
    setDrawerLive(false);
  }, [drawerX, drawerClosedX]);
  // Nothing appears until the drag is clearly an open: `openCommit` dp of committed
  // travel, after which the panel continues from the edge under the finger.
  const openCommit = 28;
  const finishOpen = useCallback((gesture: { dx: number; vx: number }) => {
    if (gesture.dx > 64 || gesture.vx > 0.35) openDrawer();
    else closeDrawer(gesture.vx * -drawerClosedX);
  }, [openDrawer, closeDrawer, drawerClosedX]);
  const openPan = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponderCapture: (_event, gesture) =>
      !drawer && gesture.x0 < 48 && gesture.dx > openCommit && Math.abs(gesture.dx) > Math.abs(gesture.dy) * 2.2,
    onPanResponderGrant: () => { setDrawer(true); setDrawerLive(false); },
    onPanResponderMove: (_event, gesture) => {
      drawerX.setValue(Math.min(0, drawerClosedX + (gesture.dx - openCommit) * 1.2));
    },
    onPanResponderRelease: (_event, gesture) => finishOpen({ dx: gesture.dx - openCommit, vx: gesture.vx }),
    onPanResponderTerminate: (_event, gesture) => finishOpen({ dx: gesture.dx - openCommit, vx: gesture.vx }),
  }), [drawer, drawerX, drawerClosedX, finishOpen]);
  const finishClose = useCallback((gesture: { dx: number; vx: number }) => {
    const velocity = gesture.vx * -drawerClosedX;
    if (gesture.dx < -drawerWidth * 0.25 || gesture.vx < -0.5) closeDrawer(velocity);
    else settle(0, velocity);
  }, [drawerWidth, drawerClosedX, closeDrawer, settle]);
  const closePan = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponderCapture: (_event, gesture) =>
      gesture.dx < -8 && Math.abs(gesture.dx) > Math.abs(gesture.dy) * 2,
    // Only leftward travel moves the panel: a rightward drag stays pinned open
    // instead of sliding the panel off the right edge.
    onPanResponderMove: (_event, gesture) => {
      drawerX.setValue(Math.max(drawerClosedX, Math.min(0, gesture.dx)));
    },
    onPanResponderRelease: (_event, gesture) => finishClose(gesture),
    onPanResponderTerminate: (_event, gesture) => finishClose(gesture),
  }), [drawerX, drawerClosedX, finishClose]);

  useEffect(() => {
    let alive = true;
    let unsubscribe: (() => void) | undefined;
    if (uiAction) { try { requireVerification(); } catch (failure) { void Promise.resolve().then(() => setError(String(failure))); return; } }
    if (uiAction?.startsWith('ui-live-')) {
      const keys: string[] = [];
      const proxy = new Proxy([1], { getOwnPropertyDescriptor(target, property) { keys.push(typeof property); return Reflect.getOwnPropertyDescriptor(target, property); } });
      Object.getOwnPropertyDescriptor(proxy, 0); Object.getOwnPropertyDescriptor(proxy, '0');
      Rxd.report(JSON.stringify({ event: 'arxd-hermes-proxy', keys }));
    }
    void getAndroidWorkspace().then(async (core) => {
      if (!alive) return;
      setWorkspace(core); setSnapshot(core.getSnapshot());
      unsubscribe = core.subscribe((value) => { if (alive) { setSnapshot(value); reportActivitySample(uiAction, value); const last = value.turns.at(-1); if (value.busy && last?.answer) {
        const count = streamSamples.current.size; streamSamples.current.add(last.answer.length);
        const size = streamSamples.current.size;
        if (uiAction?.startsWith('ui-live-') && size !== count && (size & (size - 1)) === 0)
          reportStreamSample(uiAction, size, last.answer.length);
      } } });
      if (uiAction && actionStarted.current !== uiRequest) {
        actionStarted.current = uiRequest;
        await runUiAction(uiAction, core, { streamSamples: streamSamples.current, alive: () => alive, onError: (message) => { if (alive) setError(message); } });
      }
    }).catch((failure) => { if (alive) setError(String(failure)); });
    return () => { alive = false; unsubscribe?.(); };
  }, [uiAction, uiRequest]);

  useEffect(() => {
    // Consume this screen's params even while a configuration remount is still
    // binding the global imperative router bridge.
    if (params.composeId && (typeof params.prompt !== 'string' || params.composeId === appliedComposeId) && (!params.attachmentId || params.composeId === appliedAttachmentId)) navigation.setParams({ prompt: undefined, composeId: undefined, attachmentId: undefined });
  }, [navigation, params.composeId, params.prompt, params.attachmentId, appliedComposeId, appliedAttachmentId]);

  useEffect(() => {
    const transition = Animated.timing(quickAnim, { toValue: quickMenu ? 1 : 0, duration: reducedMotion ? 0 : quickMenu ? motion.enter : motion.exit, easing: Easing.out(Easing.cubic), useNativeDriver: true });
    transition.start(({ finished }) => { if (finished && !quickMenu) setQuickMounted(false); });
    return () => transition.stop();
  }, [quickMenu, quickAnim, reducedMotion]);
  useEffect(() => {
    const transition = Animated.timing(modelAnim, { toValue: modelMenu ? 1 : 0, duration: reducedMotion ? 0 : modelMenu ? motion.enter : motion.exit, easing: Easing.out(Easing.cubic), useNativeDriver: true });
    transition.start(({ finished }) => { if (finished && !modelMenu) setModelMounted(false); });
    return () => transition.stop();
  }, [modelMenu, modelAnim, reducedMotion]);
  const dismissModelMenu = useCallback(() => {
    modelAnim.stopAnimation();
    modelAnim.setValue(0);
    setModelMenu(false);
    setModelMounted(false);
  }, [modelAnim]);
  const dismissQuickMenu = useCallback(() => {
    quickAnim.stopAnimation();
    quickAnim.setValue(0);
    setQuickMenu(false);
    setQuickMounted(false);
  }, [quickAnim]);
  const openModelMenu = useCallback(() => {
    if (quickMenu) dismissQuickMenu();
    setModelMounted(true);
    setModelMenu(true);
  }, [quickMenu, dismissQuickMenu]);
  const openQuickMenu = useCallback(() => {
    if (modelMenu) dismissModelMenu();
    setQuickMounted(true);
    setQuickMenu(true);
  }, [modelMenu, dismissModelMenu]);
  // The drawer owns the whole window, so any open layer goes with it: otherwise the
  // menu stays open underneath and reappears (and wins the back button) after close.
  useEffect(() => { if (!drawer) return; dismissModelMenu(); dismissQuickMenu(); }, [drawer, dismissModelMenu, dismissQuickMenu]);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(''), 2600); return () => clearTimeout(timer); }, [notice]);
  useEffect(() => {
    const listener = BackHandler.addEventListener('hardwareBackPress', () => {
      if (detail) { setDetail(null); return true; }
      if (modelMenu) { setModelMenu(false); return true; }
      if (quickMenu) { setQuickMenu(false); return true; }
      if (sheet) { setSheet(null); return true; }
      if (drawer) { closeDrawer(); return true; }
      return false;
    });
    return () => listener.remove();
  }, [detail, sheet, drawer, modelMenu, quickMenu, closeDrawer]);

  async function perform(action: () => Promise<unknown>) {
    setError('');
    try { await action(); } catch (failure) { setError(String(failure).replace(/^Error: /, '')); }
  }
  function showDetail(value: Detail) { setTab('preview'); setDetail(value); setSheet(null); }
  function openProfile() {
    setProfileDraft({ ...profile });
    setProfileError('');
    setProfileOpen(true);
    closeDrawer();
  }
  async function chooseAvatar() {
    const picked = await DocumentPicker.getDocumentAsync({ type: 'image/*', copyToCacheDirectory: true, multiple: false });
    if (picked.canceled) return;
    const asset = picked.assets[0];
    setProfileDraft((old) => old ? { ...old, pending: { uri: asset.uri, name: asset.name } } : old);
  }
  async function saveProfile() {
    if (!profileDraft || profileBusy) return;
    setProfileBusy(true); setProfileError('');
    let imported: WorkspaceFile | undefined;
    try {
      if (profileDraft.pending) imported = await Rxd.importFile(profileDraft.pending.uri, profileDraft.pending.name, importLimit());
      const avatar = imported ? { uri: imported.uri, sha256: imported.sha256 } : profileDraft.avatar;
      const next: LocalProfile = { name: profileDraft.name.trim().slice(0, 40), ...(avatar ? { avatar } : {}) };
      await SecureStore.setItemAsync(PROFILE_KEY, JSON.stringify(next));
      const previous = profile.avatar;
      setProfile(next); setProfileOpen(false);
      if (previous && previous.uri !== avatar?.uri) void Rxd.deleteCapture(previous.uri, previous.sha256).catch(() => undefined);
    } catch (failure) {
      if (imported) void Rxd.deleteCapture(imported.uri, imported.sha256).catch(() => undefined);
      setProfileError(String(failure).replace(/^Error: /, '').slice(0, 500));
    } finally {
      setProfileBusy(false);
    }
  }
  async function send(text = draft, fileId = pending?.id ?? (snapshot?.turns.at(-1)?.file?.available === false ? undefined : snapshot?.turns.at(-1)?.file?.id)) {
    // Only this conversation's own run blocks a send: another conversation may be
    // generating at the same time, and the runtime admits one run per conversation.
    if (!workspace || !text.trim() || sending.current || busy) return;
    followOutput.current = true;
    sending.current = true; setWorking(true); setError(''); Keyboard.dismiss();
    setDraft(''); setPending(null); setInputHeight(44);
    try { const value = await workspace.send(text, fileId); if (uiAction) await reportUiStage('ui-sent', value); }
    catch (failure) { setError(String(failure).replace(/^Error: /, '')); }
    finally { sending.current = false; setWorking(false); }
  }
  async function shareAnswer(text: string) {
    if (!text.trim()) return;
    try { await Share.share({ message: text, title: t("Share Arxd answer") }); }
    catch (failure) { if (!/cancel/i.test(String(failure))) setError(String(failure).replace(/^Error: /, '')); }
  }
  function beginInlineEdit(turn: TurnView) {
    setInlineEdit({ turnId: turn.id, fileId: turn.file && turn.file.available !== false ? turn.file.id : '', file: turn.file, text: turn.prompt });
    setPending(null);
  }
  async function saveInlineEdit() {
    if (!workspace || !inlineEdit || !inlineEdit.text.trim() || sending.current || busy) return;
    const target = inlineEdit;
    followOutput.current = true;
    sending.current = true; setWorking(true); setError(''); Keyboard.dismiss();
    try {
      const value = await workspace.editTurn(target.turnId, target.text, target.fileId);
      setInlineEdit(undefined);
      if (uiAction) await reportUiStage('ui-sent', value);
    } catch (failure) { setError(String(failure).replace(/^Error: /, '')); }
    finally { sending.current = false; setWorking(false); }
  }
  async function regenerateTurn(turn: TurnView) {
    if (!workspace || sending.current || busy) return;
    followOutput.current = true;
    sending.current = true; setWorking(true); setError('');
    try { const value = await workspace.regenerate(turn.id); if (uiAction) await reportUiStage('ui-sent', value); }
    catch (failure) { setError(String(failure).replace(/^Error: /, '')); }
    finally { sending.current = false; setWorking(false); }
  }
  const exportableTurn = snapshot ? [...snapshot.turns].reverse().find((turn) => turn.status !== 'running' && turn.tools.length > 0) : undefined;
  function exportReport() {
    if (!exportableTurn) return;
    const artifact = workspace?.report(exportableTurn.id);
    if (!artifact) return;
    dismissQuickMenu();
    showDetail({ kind: 'artifact', artifact });
  }
  function selectBranch(delta: number) {
    const branch = snapshot?.branch;
    if (!branch || !workspace) return;
    const target = branch.versions[branch.index - 1 + delta];
    if (!target || target.active) return;
    setInlineEdit(undefined);
    setPending(null);
    void perform(() => workspace.select(target.id));
  }
  async function stop() {
    if (!workspace) return;
    setWorking(true);
    await perform(async () => { const value = await workspace.stop(); if (uiAction) await reportUiStage('ui-stopped', value); });
    setWorking(false);
  }
  async function sample() {
    if (!workspace || busy || working) return;
    setWorking(true);
    await perform(async () => {
      const file = await Rxd.importSource('arxd-sample.js', SAMPLE_SOURCE);
      await workspace.attach(file); setPending(file);
      setSheet(null);
    });
    setWorking(false);
  }
  async function pickFile() {
    if (!workspace || busy || working) return;
    setSheet(null);
    const selection = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: false, multiple: false });
    if (selection.canceled) return;
    setWorking(true);
    await perform(async () => {
      const asset = selection.assets[0];
      const limit = importLimit();
      if (asset.size !== undefined && asset.size > limit) throw new Error(t("File exceeds the current import limit of {size}", { size: importLimitLabel() }));
      const file = await Rxd.importFile(asset.uri, asset.name, limit);
      await workspace.attach(file); setPending(file);
      if (uiAction) await reportUiStage('ui-imported', await workspace.refresh());
    });
    setWorking(false);
  }
  async function share(artifact: Artifact) {
    await perform(async () => {
      if (!await Sharing.isAvailableAsync()) throw new Error(t("No sharing target available on this device"));
      const uri = await Rxd.exportText(artifact.name, artifact.content);
      await Sharing.shareAsync(uri, { mimeType: artifact.mime, dialogTitle: t("Share Arxd analysis artifact") });
    });
  }
  // The composer grows into place with the keyboard: it lifts a few dp, settles to
  // a squarer radius and picks up its outline, so the tap reads as an expansion
  // instead of the panels jumping.
  const [composeFocus, setComposeFocus] = useState(false);
  const [composeAnim] = useState(() => new Animated.Value(0));
  // Thinking level: the chip opens a small menu above itself, and the selection can
  // be stepped up or down inside it; the highlight slides instead of jumping.
  useEffect(() => {
    const animation = Animated.timing(composeAnim, {
      toValue: composeFocus ? 1 : 0,
      duration: reducedMotion ? 0 : motion.focus,
      easing: composeFocus ? Easing.out(Easing.cubic) : Easing.in(Easing.cubic),
      useNativeDriver: false,
    }); animation.start(); return () => animation.stop();
  }, [composeFocus, composeAnim, reducedMotion]);
  const thinkTone = useCallback((level: ModelThinkingLevel) => level === 'off' ? c.faint
    : level === 'minimal' ? shade(c.accent, -.45)
    : level === 'low' ? shade(c.accent, -.25)
    : level === 'medium' ? shade(c.accent, .12)
    : level === 'high' ? c.accent
    : level === 'xhigh' ? shade(c.thinking, -.2)
    : c.thinking, [c]);
  const id = snapshot?.active ?? null;
  const shownConversations = (snapshot?.conversations ?? []);
  const visibleConversations = shownConversations.filter((row) => !row.archived);
  const archived = !!snapshot?.conversations.find((item) => item.id === id)?.archived;
  const modelChoices = snapshot?.models ?? [];
  const hasModels = modelChoices.length > 0;
  const thinkLevels = modelChoices.find((model) => model.id === snapshot?.model)?.thinking ?? ['off'] as ModelThinkingLevel[];
  const thinkIndex = Math.max(0, thinkLevels.indexOf(snapshot?.thinking ?? 'off'));
  useEffect(() => { if (!hasModels && modelMenu) dismissModelMenu(); }, [hasModels, modelMenu, dismissModelMenu]);
  // The top level is the only one that animates: a slow colour drift reads as
  // "flowing light" without a masked gradient or an extra dependency.
  const shimmering = thinkLevels[thinkIndex] === 'max';
  const [shimmer] = useState(() => new Animated.Value(0));
  // The loop also runs while the menu is open, so the top level shimmers in the list
  // even when it is not the current one.
  const shimmerLive = !reducedMotion && path === '/' && !drawer && !sheet && !detail && (shimmering || modelMenu);
  useEffect(() => {
    if (!shimmerLive) { shimmer.stopAnimation(); shimmer.setValue(0); return; }
    // A newly mounted Animated.Text attached to an already-running JS loop keeps a
    // frozen colour until another render. Restart from zero whenever the label can
    // (re)mount so the first selection animates immediately.
    shimmer.stopAnimation();
    shimmer.setValue(0);
    const loop = Animated.loop(Animated.timing(shimmer, { toValue: 1, duration: 2600, easing: Easing.linear, useNativeDriver: false }));
    loop.start();
    return () => loop.stop();
  }, [shimmerLive, shimmering, modelMenu, shimmer]);
  const shimmerColor = shimmer.interpolate({ inputRange: [0, 0.25, 0.5, 0.75, 1], outputRange: [c.thinking, c.accent, c.danger, c.thinking, c.thinking] });

  // Only a message that can actually be sent lights the accent disc; an empty draft
  // keeps a neutral circle so the composer has no large coloured blob.
  const sendLive = busy || (!!draft.trim() && !working && !!workspace);
  const composerActions = <Pressable accessibilityRole="button" accessibilityLabel={busy ? t("Stop analysis") : t("Send message")} testID={busy ? 'stop-analysis' : 'send-message'} disabled={!sendLive} onPress={() => { if (busy) void stop(); else void send(); }} style={({ pressed }) => [s.sendButton, { backgroundColor: sendLive && !busy ? c.accent : c.raised, opacity: pressed && sendLive ? .75 : 1 }]}><Icon name={busy ? 'stop' : 'arrow'} color={busy ? c.accent : sendLive ? c.background : c.faint} size={22} /></Pressable>;
  const capacity = <ContextCapacity value={snapshot?.capacity} c={c} modelLabel={snapshot?.modelLabel ?? t("No model configured")} busy={busy} active={!!snapshot?.active} compacting={!!snapshot?.compactions.length} compactionError={snapshot?.compactionError}
    onCompact={async () => { const result = await workspace?.compact(); setNotice(t(result?.cancelled ? 'Context compaction cancelled' : result?.compacted ? 'Context compacted; original history retained' : 'The current context does not need compaction')); }}
    onCancel={async () => { await workspace?.cancelCompaction(); }} />;
  const attachButton = <Pressable accessibilityRole="button" accessibilityLabel={t("Add file")} testID="attach-file" disabled={!workspace || busy || working} onPress={() => setSheet('import')} style={({ pressed }) => [s.composerIcon, pressed && { opacity: .55 }, (!workspace || busy || working) && { opacity: .35 }]}><Icon name="plus" color={c.quiet} size={22} /></Pressable>;
  function actionButton(name: IconName, label: string, onPress: () => void, testID?: string, disabled = false, strong = false, size = 46) {
    return <Pressable accessibilityRole="button" accessibilityLabel={label} testID={testID} onPress={onPress} disabled={disabled} style={({ pressed }) => [s.iconButton, strong && { width: size, height: size, borderRadius: size / 2 }, pressed && { opacity: .55 }, disabled && { opacity: .35 }]}><Icon name={name} color={strong ? c.text : c.quiet} size={strong ? Math.round(size * 0.46) : 21} /></Pressable>;
  }
  async function chooseModel(id: ModelMode) {
    if (!workspace) return;
    await perform(async () => {
      const model = snapshot?.models.find((model) => model.id === id);
      if (model && !model.available && model.offline && id !== 'test') { dismissModelMenu(); router.push({ pathname: '/models', params: { local: '1' } }); return; }
      if (model && !model.available && model.connectionId) { dismissModelMenu(); router.push({ pathname: '/models/connection', params: { id: model.connectionId } }); return; }
      await workspace.model(id);
    });
  }
  function fileChip(file: WorkspaceFile, compact = false) {
    return <Pressable accessibilityRole="button" accessibilityLabel={t("View file {name}", { name: file.name })} onPress={() => showDetail({ kind: 'file', file })} style={({ pressed }) => [s.fileChip, { borderColor: c.line, backgroundColor: c.surface }, compact && { alignSelf: 'flex-start' }, pressed && { opacity: .55 }]}>
      <Icon name="file" color={c.accent} size={23} /><View style={{ flexShrink: 1 }}><Text numberOfLines={1} style={[s.fileName, { color: c.heading }]}>{file.name}</Text><Text style={[s.tiny, { color: c.quiet }]}>{file.available === false ? t("File deleted") : `${file.format} · ${fileSize(file.size)}`}</Text></View>
    </Pressable>;
  }
  function renderTurn(turn: TurnView) {
    const records = turn.tools.flatMap((tool) => tool.records.filter((r) => r.record === 'entity').map((record) => ({ tool, record })));
    return <FadeIn key={turn.id} style={s.turn} onLayout={(event) => { turnOffsets.current[turn.id] = event.nativeEvent.layout.y; }}>
      <View style={s.userTurn}>
        {turn.file && fileChip(turn.file)}
        {inlineEdit?.turnId === turn.id ? <View style={[s.inlineEdit, { backgroundColor: c.surface, borderColor: c.accentLine }]}>
          <TextInput autoFocus testID="inline-edit-input" accessibilityLabel={t("Edit prompt")} value={inlineEdit.text} onChangeText={(text) => setInlineEdit((current) => current ? { ...current, text } : current)} onFocus={() => { const offset = turnOffsets.current[turn.id]; if (offset !== undefined) setTimeout(() => scroll.current?.scrollTo({ y: Math.max(0, offset - 24), animated: true }), 320); }} multiline maxLength={MAX_MESSAGE_CHARS} style={[s.body, s.inlineInput, { color: c.text }]} />
          <View style={s.inlineActions}>
            <Pressable accessibilityRole="button" accessibilityLabel={t("Cancel editing")} testID="inline-edit-cancel" onPress={() => setInlineEdit(undefined)} style={({ pressed }) => [s.inlineAction, pressed && { opacity: .55 }]}><Text style={[type.label, { color: c.quiet }]}>{t("Cancel")}</Text></Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel={t("Save and regenerate")} testID="inline-edit-save" disabled={!inlineEdit.text.trim() || busy || working} onPress={() => { void saveInlineEdit(); }} style={({ pressed }) => [s.inlineAction, pressed && { opacity: .55 }, (!inlineEdit.text.trim() || busy || working) && { opacity: .35 }]}><Text style={[type.label, { color: c.accent }]}>{t("Save and regenerate")}</Text></Pressable>
          </View>
        </View> : <>
          <View style={[s.userBubble, { backgroundColor: c.raised }]}><Text selectable style={[s.body, { color: c.text }]}>{turn.prompt}</Text></View>
          <Pressable accessibilityRole="button" accessibilityLabel={t("Edit prompt")} onPress={() => beginInlineEdit(turn)} style={({ pressed }) => [s.userEdit, pressed && { opacity: .55 }]}><Icon name="edit" color={c.quiet} size={13} /><Text style={[type.micro, { color: c.quiet }]}>{t("Edit")}</Text></Pressable>
        </>}
      </View>
      <ResponseActivity turn={turn} c={c} onTool={(tool) => showDetail({ kind: 'tool', tool, file: turn.file })}
        onCopy={() => { void Clipboard.setStringAsync(turn.answer).then(() => setNotice(t("Copied"))); }}
        onShare={() => { void shareAnswer(turn.answer); }}
        onRegenerate={() => { void regenerateTurn(turn); }}
        onContinue={() => { void send(t("Continue"), ''); }}
        caret={turn.status === 'running' && turn.phase === 'answer' ? <LiveCaret color={c.accent} /> : undefined} />
      {records.length > 0 && <View><Text style={[s.sectionTitle, { color: c.heading }]}>{t("Structural evidence you can check")}</Text>{records.slice(0, 6).map(({ tool, record }, index) => {
        const value = typeof record.detail === 'object' && record.detail && !Array.isArray(record.detail) ? record.detail : {};
        const name = typeof value.name === 'string' ? value.name : t("Entity {index}", { index: index + 1 });
        return <Pressable key={`${tool.id}-${index}`} accessibilityRole="button" accessibilityLabel={t("View evidence {name}", { name })} onPress={() => showDetail({ kind: 'tool', tool, file: turn.file, record })} style={({ pressed }) => [s.evidence, { borderColor: c.line }, pressed && { opacity: .55 }]}><Text style={[s.tiny, { color: c.accent }]}>{t("Evidence")} {String(index + 1).padStart(2, '0')}</Text><Text numberOfLines={1} style={[s.evidenceName, { color: c.heading }]}>{name}</Text><Text style={[s.tiny, { color: c.quiet }]}>{turn.file?.name ?? t("Local structure query")} · {t("Tap to inspect the raw record")}</Text></Pressable>;
      })}{records.length > 6 && <Text style={[s.caption, { color: c.quiet }]}>{t("The other {count} are in the raw tool output.", { count: records.length - 6 })}</Text>}</View>}
    </FadeIn>;
  }

  function recordPreview(record: Record<string, unknown>, file: WorkspaceFile | null) {
    const info = record.detail && typeof record.detail === 'object' ? record.detail as Record<string, unknown> : {};
    const start = typeof record.start === 'number' ? record.start : 0;
    const end = typeof record.end === 'number' ? record.end : 0;
    const source = file?.source;
    const excerpt = source !== null && source !== undefined && start >= 0 && end >= start
      ? new TextDecoder().decode(new TextEncoder().encode(source).slice(start, end)) : null;
    const kinds: Record<string, string> = { program: t("module"), function_declaration: t("function declaration"), class_declaration: t("class declaration"), method: t("method"), variable_declaration: t("variable declaration") };
    const kind = typeof info.kind === 'string' ? kinds[info.kind] ?? info.kind : t("Structure entity");
    return <View>
      <Text style={[s.previewName, { color: c.heading }]}>{typeof info.name === 'string' ? info.name : typeof info.label === 'string' ? info.label : file?.name ?? t("Module structure")}</Text>
      <Text style={[s.caption, { color: c.accent, marginBottom: 22 }]}>{kind} · {t("UTF-8 bytes {start}–{end}", { start, end })}</Text>
      {excerpt !== null && <View style={[s.codeFrame, { backgroundColor: c.code, borderColor: c.line }]}><CodeBlock code={excerpt || t("(empty range)")} language={languageForFile(file?.name ?? '')} c={c} /></View>}
      <Text style={[s.dialogNote, { color: c.quiet }]}>{t("This text comes from the import snapshot. Switch to \"Raw record\" to check entity IDs, the file hash and the full tool result.")}</Text>
    </View>;
  }

  const panelTitle = (detail: Detail) => detail?.kind === 'file' ? detail.file.name : detail?.kind === 'artifact' ? detail.artifact.name : detail?.kind === 'tool' ? detail.record ? t("Structural evidence") : toolLabel(detail.tool.name, detail.tool.details) : '';
  return <KeyboardAvoidingView behavior="height" style={s.screen}><SafeAreaView style={[s.screen, { backgroundColor: c.background }]} edges={['top', 'bottom']} {...openPan.panHandlers}>
    <View style={s.header} onLayout={(event) => setHeaderHeight(event.nativeEvent.layout.height)}>
      {actionButton('menu', t("Open conversation history"), openDrawer, 'open-history', false, true)}
      <Pressable accessibilityRole="button" accessibilityLabel={t(hasModels ? 'Choose model' : 'Add model')} testID="open-models" disabled={!workspace} onPress={() => { if (!hasModels) { dismissModelMenu(); router.push('/models'); return; } if (modelMenu) dismissModelMenu(); else openModelMenu(); }} style={({ pressed }) => [s.modelButton, pressed && { opacity: .55 }, !workspace && { opacity: .35 }]}>
        <View style={s.modelLabel}>
          <Text numberOfLines={1} style={[s.modelName, { color: c.heading, flexShrink: 1 }]}>{hasModels ? snapshot?.modelLabel ?? t("No model configured") : t("Add model")}</Text>
          {thinkLevels.length > 1 && <>
            <Text style={[s.modelName, { color: c.quiet }]}>{' · '}</Text>
            {shimmering
              ? <Animated.Text style={[s.modelName, { color: shimmerColor }]}>{thinkLevels[thinkIndex]}</Animated.Text>
              : <Text style={[s.modelName, { color: thinkTone(thinkLevels[thinkIndex]) }]}>{thinkLevels[thinkIndex]}</Text>}
          </>}
        </View>
        <View style={[s.modelArrow, !hasModels && s.modelArrowRight]}><Icon name={hasModels ? 'chevron' : 'right'} color={c.quiet} size={16} /></View>
      </Pressable>
      <View style={{ flex: 1 }} />
      {(!!snapshot?.active || modelMenu) && <View style={s.headerCapsule}>
        {!!snapshot?.active && <>
          <Pressable accessibilityRole="button" accessibilityLabel={t("New chat")} testID="new-conversation" disabled={!workspace || working || busy} onPress={() => { setPending(null); setDraft(''); void perform(async () => { await workspace?.select(null); }); }} style={({ pressed }) => [s.headerSegment, pressed && { opacity: .55 }, (!workspace || working || busy) && { opacity: .35 }]}>
            <Icon name="compose" color={c.text} size={17} />
          </Pressable>
          <View style={[s.headerDivider, { backgroundColor: c.line }]} />
        </>}
        <Pressable accessibilityRole="button" accessibilityLabel={t(modelMenu ? 'Close the model menu' : quickMenu ? 'Close menu' : 'More')} testID="open-quick-menu" onPress={() => { if (modelMenu) { dismissModelMenu(); return; } if (quickMenu) { setQuickMenu(false); return; } openQuickMenu(); }} style={({ pressed }) => [s.headerSegment, pressed && { opacity: .55 }]}>
          <Icon name={modelMenu || quickMenu ? 'close' : 'more'} color={c.text} size={17} />
        </Pressable>
      </View>}
    </View>
    {!!snapshot?.branch && snapshot.branch.count > 1 && <View style={s.branchBar} testID="branch-bar">
      <Pressable accessibilityRole="button" accessibilityLabel={t("Previous version")} testID="branch-prev" disabled={snapshot.branch.index <= 1} onPress={() => selectBranch(-1)} style={({ pressed }) => [s.branchButton, pressed && { opacity: .55 }, snapshot.branch!.index <= 1 && { opacity: .3 }]}><View style={{ transform: [{ rotate: '90deg' }] }}><Icon name="chevron" color={c.text} size={18} /></View></Pressable>
      <Text style={[type.caption, { color: c.quiet }]}>{snapshot.branch.index} / {snapshot.branch.count}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel={t("Next version")} testID="branch-next" disabled={snapshot.branch.index >= snapshot.branch.count} onPress={() => selectBranch(1)} style={({ pressed }) => [s.branchButton, pressed && { opacity: .55 }, snapshot.branch!.index >= snapshot.branch!.count && { opacity: .3 }]}><View style={{ transform: [{ rotate: '-90deg' }] }}><Icon name="chevron" color={c.text} size={18} /></View></Pressable>
    </View>}
    {(error || snapshot?.error) && <Pressable accessibilityRole="button" accessibilityLabel={t("Dismiss the error")} onPress={() => setError('')} style={[s.errorBar, { backgroundColor: c.wash }]}><Text style={[s.caption, { color: c.danger }]}>{t(error || snapshot?.error || '')}</Text></Pressable>}
    {!!snapshot?.deletions.length && <View style={[s.compaction, { backgroundColor: c.surface, borderColor: c.line }]}>
      <Icon name="trash" color={c.danger} size={18} /><View style={{ flex: 1 }}><Text style={[type.caption, { color: c.heading }]}>{t("Deleting conversation; files will be retained")}</Text>{snapshot.deletions.map((item) => <View key={item.id} style={{ marginTop: 8, gap: 6 }}><Text style={[type.caption, { color: c.quiet }]}>{item.error || t("Stopping tasks and removing records")}</Text><Pressable accessibilityRole="button" accessibilityLabel={t("Retry deleting conversation {id}", { id: item.id })} onPress={() => { void perform(async () => { await workspace?.purge(item.id); }); }}><Text style={[type.label, { color: c.accent }]}>{t("Retry deletion")}</Text></Pressable></View>)}</View>
    </View>}
    {(!!snapshot?.compactions.length || !!snapshot?.compactionError) && <View style={[s.compaction, { backgroundColor: c.surface, borderColor: c.line }]}>
      {!!snapshot?.compactions.length && <BusyIndicator size="small" color={c.accent} />}
      <Text style={[type.caption, { color: snapshot?.compactionError ? c.danger : c.quiet, flex: 1 }]}>{snapshot?.compactions.length ? t(snapshot.compactions.some((item) => item.blocking) ? 'Compacting context; the answer will continue afterward' : 'Compacting context in the background') : t("Context compaction failed; you can retry")}{snapshot?.compactionError ? ` · ${snapshot.compactionError}` : ''}{snapshot?.compactions.find((item) => item.retryAt) ? ` · ${t('Network retry {attempt}/3', { attempt: snapshot.compactions.find((item) => item.retryAt)!.attempt })}` : ''}</Text>
      {!!snapshot?.compactions.length && <Pressable accessibilityRole="button" accessibilityLabel={t("Stop compaction")} onPress={() => { void perform(async () => { await workspace?.cancelCompaction(); }); }} style={s.compactionStop}><Icon name="stop" color={c.quiet} size={16} /></Pressable>}
    </View>}
    <CompactionRequests records={snapshot?.requestRecords ?? []} pending={snapshot?.compactions ?? []} c={c} />
    <ScrollView ref={scroll} style={{ flex: 1 }} contentContainerStyle={snapshot?.turns.length ? s.transcript : s.welcomeContent} keyboardShouldPersistTaps="handled" scrollEventThrottle={32} onScroll={({ nativeEvent }) => { followOutput.current = nativeEvent.contentSize.height - nativeEvent.layoutMeasurement.height - nativeEvent.contentOffset.y < 72; }} onContentSizeChange={() => { if (busy && followOutput.current) scroll.current?.scrollToEnd({ animated: true }); }}>
      {!snapshot?.turns.length ? <View style={s.welcome}>
        <View style={s.heroMark} accessibilityRole="image" accessibilityLabel={t("Arxd mark")}><Mark size={78} color={c.heading} /></View>
        <Text style={[s.greeting, { color: c.accent }]}>{t("Hello, {name}", { name: profile.name.trim() || t("Stranger") })}</Text>
        <Text style={[s.heroTitle, { color: c.heading }]}>{t("What do you want to explore?")}</Text>
      </View> : <>{snapshot.hasMoreHistory && <Pressable onPress={() => { void perform(async () => { await workspace?.earlier(); }); }} style={s.moreHistory}><Text style={[s.caption, { color: c.accent }]}>{t("Show earlier messages")}</Text></Pressable>}{snapshot?.turns.map(renderTurn)}</>}
    </ScrollView>
    {!inlineEdit && <View style={s.composeArea}>
      {archived && <View style={[s.compaction, { backgroundColor: c.surface, borderColor: c.line }]}><Icon name="archive" color={c.quiet} size={17} /><Text style={[s.caption, { color: c.quiet, flex: 1 }]}>{t("This conversation is archived. Sending a message restores it.")}</Text><Pressable accessibilityRole="button" accessibilityLabel={t("Restore this conversation")} onPress={() => { if (id) void perform(() => workspace!.archive(id, false)); }} style={s.compactionStop}><Text style={[s.caption, { color: c.accent }]}>{t("Restore")}</Text></Pressable></View>}
    {!!anotherBusy && <Pressable onPress={() => { void perform(async () => { await workspace?.select(anotherBusy.id); }); }} style={s.returnTask}><BusyIndicator size="small" color={c.accent} /><Text style={[s.caption, { color: c.quiet }]}>{t("Another conversation is running; tap to return")}</Text></Pressable>}
      <Animated.View style={[s.composer, {
        backgroundColor: composeAnim.interpolate({ inputRange: [0, 1], outputRange: [c.raised, c.surface] }),
        borderColor: pending ? c.accentLine : composeAnim.interpolate({ inputRange: [0, 1], outputRange: [c.raised, c.line] }),
        borderRadius: composeAnim.interpolate({ inputRange: [0, 1], outputRange: [29, 22] }),
        transform: [
          { translateY: composeAnim.interpolate({ inputRange: [0, 1], outputRange: [0, -3] }) },
          { scale: composeAnim.interpolate({ inputRange: [0, 1], outputRange: [1, 1.012] }) },
        ],
      }]}>
        {!!(snapshot?.selectedSkills.length || pending) && <ScrollView style={s.composerAttachments} keyboardShouldPersistTaps="handled" nestedScrollEnabled>
        {!!snapshot?.selectedSkills.length && <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 7, paddingHorizontal: 8, paddingVertical: 7 }}>{snapshot.selectedSkills.map((skill) => <Pressable key={skill.id} accessibilityRole="button" accessibilityLabel={t("Remove selected skill {name}", { name: skill.name })} disabled={busy || working} onPress={() => { void perform(async () => { await workspace?.skills.choose(skill.id, false); }); }} style={[s.skillChip, { borderColor: c.line, backgroundColor: c.surface }]}><Icon name="spark" color={skill.available ? c.accent : c.danger} size={15} /><Text numberOfLines={1} style={[type.caption, { color: c.text, maxWidth: 160 }]}>{skill.name}{skill.available ? '' : ` · ${t('Disabled')}`}</Text><Icon name="close" color={c.quiet} size={14} /></Pressable>)}</ScrollView>}
        {pending && <View style={[s.pending, { backgroundColor: c.surface, borderColor: c.line }]}><Icon name="file" color={c.accent} size={19} /><View style={{ flex: 1 }}><Text numberOfLines={1} style={[s.fileName, { color: c.text }]}>{pending.name}</Text><Text style={[s.tiny, { color: c.quiet }]}>{fileSize(pending.size)} · {t("Local snapshot")}</Text></View>{actionButton('close', t("Remove attachment"), () => setPending(null), 'remove-attachment')}</View>}
        </ScrollView>}
        <View style={[s.composerRow, { height: composeFocus ? Math.max(64, inputHeight) : inputHeight, minHeight: composeFocus ? 64 : 44 }]}>
          {!composeFocus && attachButton}
          <TextInput ref={input} testID="message-input" accessibilityLabel={t("Ask Arxd")} value={draft} onChangeText={setDraft} placeholder={t("Ask Arxd, or add a file")} placeholderTextColor={c.faint} multiline maxLength={MAX_MESSAGE_CHARS} returnKeyType="send" submitBehavior="submit" onSubmitEditing={() => { if (!busy && draft.trim()) void send(); }} onFocus={() => setComposeFocus(true)} onBlur={() => setComposeFocus(false)} onContentSizeChange={(e) => setInputHeight(Math.min(150, Math.max(44, e.nativeEvent.contentSize.height)))} style={[s.input, { color: c.text, height: '100%' }]} />
          {!composeFocus && capacity}
          {!composeFocus && composerActions}
        </View>
        {composeFocus && <View style={s.composerToolbar}>
          {attachButton}
          <View style={{ flex: 1 }} />
          {capacity}
          {composerActions}
        </View>}
      </Animated.View>
    </View>}




    {modelMounted && hasModels && <Animated.View testID="model-menu" pointerEvents={modelMenu ? 'auto' : 'none'} accessibilityElementsHidden={!modelMenu} style={[s.modelLayer, { top: headerHeight + insets.top, backgroundColor: c.background, opacity: modelAnim, transform: [{ translateY: modelAnim.interpolate({ inputRange: [0, 1], outputRange: [-6, 0] }) }] }]}>
      <View style={s.modelLayerBody}>
        <Text style={[s.layerLabel, { color: c.faint }]}>{t("Choose model")}</Text>
        <ScrollView style={s.modelList} contentContainerStyle={s.modelListBody} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
          {modelChoices.map((model) => {
            const current = snapshot?.model === model.id;
            return <View key={model.id}>
              <Pressable testID={`model-${model.id}`} accessibilityRole="button" accessibilityLabel={t("Use {model}", { model: t(model.label) })} disabled={!workspace || busy || working} onPress={() => { void chooseModel(model.id); }} style={({ pressed }) => [s.layerRow, pressed && { backgroundColor: c.wash }, (!workspace || busy || working) && { opacity: .4 }]}>
                {current ? <Icon name="check" color={c.accent} size={16} /> : <View style={s.menuCheckSlot} />}
                <View style={s.layerMeta}>
                  <Text numberOfLines={1} style={[s.layerTitle, { color: current ? c.heading : c.text, flexShrink: 1 }]}>{t(model.label)}</Text>
                  <Text style={[s.layerCaption, { color: contextTone(model.context, c) }]}>{contextLabel(model.context)}</Text>
                </View>
              </Pressable>
              {current && thinkLevels.length > 1 && <View style={s.thinkInline}>
                <Text style={[s.thinkLabel, { color: c.faint }]}>{t("Thinking (2)")}</Text>
                <ScrollView horizontal nestedScrollEnabled showsHorizontalScrollIndicator={false} style={s.thinkScroll} contentContainerStyle={s.thinkRow} keyboardShouldPersistTaps="handled">{thinkLevels.map((level) => {
                  const selected = level === thinkLevels[thinkIndex];
                  return <Pressable key={level} testID={`thinking-${level}`} accessibilityRole="button" accessibilityState={{ selected }} accessibilityLabel={t("Thinking level: {level}", { level })} disabled={!workspace || busy} onPress={() => { void perform(async () => { await workspace?.thinking(level); }); }} style={({ pressed }) => [s.thinkItem, pressed && { opacity: .55 }, (!workspace || busy) && { opacity: .4 }]}>
                    {selected ? <Icon name="check" color={thinkTone(level)} size={14} /> : null}
                    {level === 'max' ? <Animated.Text style={[s.thinkText, { color: selected ? shimmerColor : thinkTone(level) }]}>{level}</Animated.Text> : <Text style={[s.thinkText, { color: selected ? thinkTone(level) : c.quiet }]}>{level}</Text>}
                  </Pressable>;
                })}</ScrollView>
              </View>}
            </View>;
          })}
        </ScrollView>
        <Pressable accessibilityRole="button" accessibilityLabel={t("Manage models")} onPress={() => { dismissModelMenu(); router.push('/models'); }} style={({ pressed }) => [s.layerRow, s.manageModels, pressed && { backgroundColor: c.wash }]}>
          <Icon name="sliders" color={c.quiet} size={16} /><Text style={[s.layerTitle, { color: c.text }]}>{t("Manage models")}</Text>
        </Pressable>
      </View>
    </Animated.View>}

    {quickMounted && <Animated.View testID="quick-menu" pointerEvents={quickMenu ? 'auto' : 'none'} accessibilityElementsHidden={!quickMenu} style={[s.modelLayer, { top: headerHeight + insets.top, backgroundColor: c.background, opacity: quickAnim, transform: [{ translateY: quickAnim.interpolate({ inputRange: [0, 1], outputRange: [-6, 0] }) }] }]}>
      <View style={s.modelLayerBody}>
        <Pressable accessibilityRole="button" accessibilityLabel={t("Files in this conversation")} testID="conversation-files" disabled={!snapshot?.active} onPress={() => { dismissQuickMenu(); setSheet('files'); }} style={({ pressed }) => [s.layerRow, pressed && { backgroundColor: c.wash }, !snapshot?.active && { opacity: .4 }]}>
          <Icon name="folder" color={c.quiet} size={18} /><Text style={[s.layerTitle, { color: c.text }]}>{t("Files in this conversation")}</Text>
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel={t("Export analysis record")} testID="conversation-report" disabled={!exportableTurn} onPress={exportReport} style={({ pressed }) => [s.layerRow, pressed && { backgroundColor: c.wash }, !exportableTurn && { opacity: .4 }]}>
          <Icon name="report" color={c.quiet} size={18} /><Text style={[s.layerTitle, { color: c.text }]}>{t("Export analysis record")}</Text>
        </Pressable>
        <View style={{ height: 18 }} />
        <Pressable accessibilityRole="button" accessibilityLabel={t("Compact context")} testID="conversation-compact" disabled={!snapshot?.active || busy || !!snapshot?.compactions.length} onPress={() => { dismissQuickMenu(); void perform(async () => { const result = await workspace?.compact(); setNotice(t(result?.cancelled ? 'Context compaction cancelled' : result?.compacted ? 'Context compacted; original history retained' : 'The current context does not need compaction')); }); }} style={({ pressed }) => [s.layerRow, pressed && { backgroundColor: c.wash }, (!snapshot?.active || busy || !!snapshot?.compactions.length) && { opacity: .4 }]}>
          <Icon name="compress" color={c.quiet} size={18} /><Text style={[s.layerTitle, { color: c.text }]}>{t("Compact context")}</Text>
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel={t(archived ? 'Unarchive' : 'Archive conversation')} testID="conversation-archive" disabled={!snapshot?.active} onPress={() => { dismissQuickMenu(); void perform(async () => { if (id) await workspace?.archive(id, !archived); }); }} style={({ pressed }) => [s.layerRow, pressed && { backgroundColor: c.wash }, !snapshot?.active && { opacity: .4 }]}>
          <Icon name="archive" color={c.quiet} size={18} /><Text style={[s.layerTitle, { color: c.text }]}>{t(archived ? 'Unarchive' : 'Archive conversation')}</Text>
        </Pressable>
        <View style={{ height: 24 }} />
        <Pressable accessibilityRole="button" accessibilityLabel={t("Delete conversation (2)")} testID="conversation-delete" disabled={!snapshot?.active} onPress={() => { dismissQuickMenu(); if (id) Alert.alert(t("Delete this conversation?"), t("Conversation history will be permanently deleted. Attachments and saved files stay in the file library. Running tasks will stop first."), [{ text: t("Cancel"), style: 'cancel' }, { text: t("Delete conversation (2)"), style: 'destructive', onPress: () => { void perform(async () => { await workspace?.purge(id); }); } }]); }} style={({ pressed }) => [s.layerRow, pressed && { backgroundColor: c.wash }, !snapshot?.active && { opacity: .4 }]}>
          <Icon name="trash" color={c.danger} size={18} /><Text style={[s.layerTitle, { color: c.danger }]}>{t("Delete conversation (2)")}</Text>
        </Pressable>
      </View>
    </Animated.View>}

    {!!drawer && <View pointerEvents={drawerLive ? 'auto' : 'none'} style={[StyleSheet.absoluteFill, s.drawerOverlay]}>
      <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: c.scrim, opacity: drawerX.interpolate({ inputRange: [drawerClosedX, 0], outputRange: [0, 1], extrapolate: 'clamp' }) }]}><Pressable style={StyleSheet.absoluteFill} onPress={() => closeDrawer()} accessibilityLabel={t("Close conversation history")} /></Animated.View>
      <Animated.View {...closePan.panHandlers} style={[s.drawer, { width: drawerWidth, backgroundColor: c.nav, transform: [{ translateX: drawerX }] }]}>
        <SafeAreaView edges={['top', 'bottom']} style={{ flex: 1 }}>
        <View style={s.drawerHeader}>
          <View style={s.drawerBrandRow}><Mark size={32} color={c.heading} /><Text style={[s.drawerBrand, { color: c.heading }]}>Arxd</Text></View>
          <View style={{ flex: 1 }} />
          {actionButton('close', t("Close conversation history"), () => closeDrawer(), 'drawer-close', false, true)}
        </View>

        <Pressable accessibilityRole="button" accessibilityLabel={t("Start a new chat")} testID="drawer-new" disabled={working} onPress={() => { closeDrawer(); setPending(null); setDraft(''); void perform(async () => { await workspace?.select(null); }); }} style={({ pressed }) => [s.drawerNewRow, pressed && { backgroundColor: c.wash }, working && { opacity: .4 }]}>
          <Icon name="compose" color={c.accent} size={20} /><Text style={[s.drawerNewText, { color: c.accent }]}>{t("Start a new chat")}</Text>
        </Pressable>

        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 196 }} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
          <View style={s.drawerNav}>
            <DrawerRow c={c} icon="sliders" label={t("Models")} onPress={() => { dismissDrawer(); router.push('/models'); }} />
            <DrawerRow c={c} icon="spark" label={t("Skills")} onPress={() => { dismissDrawer(); router.push('/skills'); }} />
            <DrawerRow c={c} icon="folder" label={t("Files")} onPress={() => { dismissDrawer(); router.push('/files'); }} />
            <DrawerRow c={c} icon="grid" label={t('Split-screen analysis')} onPress={() => { dismissDrawer(); router.push('/split-screen'); }} />
            <DrawerRow c={c} icon="terminal" label={t("Processes")} onPress={() => { dismissDrawer(); router.push('/processes'); }} />
            <DrawerRow c={c} icon="grid" label={t('MCP')} onPress={() => { dismissDrawer(); router.push('/mcp'); }} />
            <DrawerRow c={c} icon="archive" label={t("Archive")} badge={String(shownConversations.filter((row) => row.archived).length)} onPress={() => { dismissDrawer(); router.push('/archive'); }} />
          </View>

          <View style={s.drawerSection}>
            <Text style={[s.drawerSectionLabel, { color: c.quiet }]}>{t("Conversations")}</Text>
            <View style={s.drawerSessionActions}>
              <Text style={[s.drawerCount, { color: c.faint }]}>{visibleConversations.length}</Text>
              <Pressable accessibilityRole="button" accessibilityLabel={t("Search conversations (2)")} testID="drawer-conversation-search" onPress={() => { dismissDrawer(); router.push('/search'); }} style={({ pressed }) => [s.drawerSearchButton, pressed && { opacity: .55 }]}><Icon name="search" color={c.text} size={18} /></Pressable>
            </View>
          </View>
          {visibleConversations.map((item) => <Pressable key={String(item.id)} accessibilityRole="button" accessibilityLabel={t("Open conversation {title}", { title: item.title })} testID={`conversation-${item.id}`} onPress={() => { closeDrawer(); setPending(null); setDraft(''); void perform(async () => { await workspace?.select(item.id); }); }} style={[s.historyItem, item.id === snapshot?.active && { backgroundColor: c.surface }]}>{item.id === snapshot?.active && <View style={[s.historyAccent, { backgroundColor: c.accent }]} />}<Text numberOfLines={2} style={[s.historyTitle, { color: item.id === snapshot?.active ? c.heading : c.text }]}>{item.title}</Text>{item.busy && <BusyIndicator size="small" color={c.accent} />}</Pressable>)}
          {!visibleConversations.length && <Text style={[s.emptyHistory, { color: c.faint }]}>{t("Your first conversation starts with a question.")}</Text>}
        </ScrollView>

        <Svg width="100%" height={230} style={s.drawerFloor} pointerEvents="none">
          <Defs><LinearGradient id="drawerFloor" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={c.nav} stopOpacity="0" />
            <Stop offset="0.34" stopColor={c.nav} stopOpacity="0.45" />
            <Stop offset="0.52" stopColor={c.nav} stopOpacity="1" />
            <Stop offset="1" stopColor={c.nav} stopOpacity="1" />
          </LinearGradient></Defs>
          <Rect x="0" y="0" width="100%" height="100%" fill="url(#drawerFloor)" />
        </Svg>
        <View pointerEvents="box-none" style={s.drawerFooter}>
          <Pressable accessibilityRole="button" accessibilityLabel={t("Local user")} testID="drawer-profile" onPress={openProfile} style={({ pressed }) => [s.drawerAvatarButton, pressed && { opacity: .55 }]}>
            <LocalAvatar name={profile.name.trim() || t("Stranger")} uri={profile.avatar?.uri} c={c} />
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel={t("Settings")} testID="drawer-settings" onPress={() => { dismissDrawer(); router.push('/settings'); }} style={({ pressed }) => [s.drawerSettings, pressed && { opacity: .6 }]}>
            <Icon name="settings" color={c.text} size={30} />
          </Pressable>
        </View>
        </SafeAreaView>
      </Animated.View>
    </View>}

    <MotionModal value={sheet} onClose={() => setSheet(null)}>{(sheet) =>
      <View style={s.sheetOverlay}><Pressable style={[StyleSheet.absoluteFill, { backgroundColor: c.scrim }]} onPress={() => setSheet(null)} accessibilityLabel={t("Close panel")} /><SafeAreaView edges={['bottom']} style={[s.sheet, { backgroundColor: c.surface }]}>
        <View style={s.sheetHeader}><Text style={[s.sheetTitle, { color: c.heading }]}>{t("Add file")}</Text>{actionButton('close', t("Close panel"), () => setSheet(null))}</View>
        <ScrollView style={{ maxHeight: 540 }} contentContainerStyle={s.sheetBody} keyboardShouldPersistTaps="handled">
          {sheet === 'files' && <>
            {!snapshot?.files.length && <Text style={[s.caption, { color: c.faint, paddingHorizontal: 4 }]}>{t("No files in this conversation yet")}</Text>}
            {snapshot?.files.map((file) => <Pressable key={file.id} accessibilityRole="button" accessibilityLabel={t("View file {name}", { name: file.name })} testID={`conversation-file-${file.id}`} onPress={() => { setSheet(null); showDetail({ kind: 'file', file }); }} style={({ pressed }) => [s.sheetRow, { borderColor: c.line }, pressed && { opacity: .55 }]}>
              <Icon name="file" color={c.accent} size={18} />
              <View style={{ flex: 1 }}><Text numberOfLines={1} style={[s.fileName, { color: c.text }]}>{file.name}</Text><Text style={[s.tiny, { color: c.quiet }]}>{fileSize(file.size)}</Text></View>
              <Icon name="right" color={c.faint} size={14} />
            </Pressable>)}
          </>}
          {sheet === 'import' && <><Pressable testID="choose-device-file" accessibilityRole="button" accessibilityLabel={t("Choose a file from the device")} onPress={() => { void perform(pickFile); }} style={[s.importOption, { borderBottomColor: c.line }]}><Icon name="upload" color={c.accent} size={23} /><View><Text style={[s.optionTitle, { color: c.heading }]}>{t("Choose from device")}</Text><Text style={[s.caption, { color: c.quiet }]}>{t("Saved to the on-device workspace · current limit {size}", { size: importLimitLabel() })}</Text></View></Pressable><Pressable testID="choose-installed-app" accessibilityRole="button" accessibilityLabel={t("Choose an installed app")} onPress={() => { setSheet(null); router.push('/installed-apps'); }} style={[s.importOption, { borderBottomColor: c.line }]}><Icon name="grid" color={c.accent} size={23} /><View><Text style={[s.optionTitle, { color: c.heading }]}>{t("Choose an installed app")}</Text><Text style={[s.caption, { color: c.quiet }]}>{t("Import a base APK and its split APKs from this device")}</Text></View></Pressable><Pressable testID="choose-sample" accessibilityRole="button" accessibilityLabel={t("Use the JavaScript sample")} onPress={() => { void sample(); }} style={[s.importOption, { borderBottomColor: c.line }]}><Icon name="code" color={c.accent} size={23} /><View><Text style={[s.optionTitle, { color: c.heading }]}>{t("Use the JavaScript sample")}</Text><Text style={[s.caption, { color: c.quiet }]}>{t("arxd-sample.js · real local structure query")}</Text></View></Pressable></>}
        </ScrollView>
      </SafeAreaView></View>}
    </MotionModal>

    <MotionModal value={detail} onClose={() => setDetail(null)} page>{(detail) =>
      <SafeAreaView edges={['top', 'bottom']} style={[s.screen, { backgroundColor: c.surface }]}>
        <View style={s.detailHeader}><View style={{ flex: 1 }}><Text style={[s.tiny, { color: c.accent }]}>{detail?.kind === 'file' ? t("Input file / import snapshot") : detail?.kind === 'artifact' ? t("Analysis artifact / real result") : t("Structural evidence / real tool output")}</Text><Text numberOfLines={2} style={[s.detailTitle, { color: c.heading }]}>{panelTitle(detail)}</Text></View>{actionButton('close', t("Close details"), () => setDetail(null))}</View>
        <View style={[s.tabs, { borderBottomColor: c.line }]}>{(['preview', 'raw'] as const).map((value) => <Pressable key={value} onPress={() => setTab(value)} style={({ pressed }) => [s.tab, { borderBottomColor: tab === value ? c.accent : 'transparent' }, pressed && { opacity: .55 }]}><Text style={[s.caption, { color: tab === value ? c.heading : c.quiet }]}>{value === 'preview' ? t("Preview") : detail?.kind === 'file' ? t("Source info") : t("Raw record")}</Text></Pressable>)}</View>
        <ScrollView contentContainerStyle={s.detailBody}>
          {detail?.kind === 'file' && (tab === 'preview' ? detail.file.source !== null ? <CodeBlock code={detail.file.source || t("(empty JavaScript file)")} language={languageForFile(detail.file.name)} c={c} textStyle={s.code} /> : <View><Icon name="file" color={c.accent} size={32} /><Text style={[s.body, { color: c.text, marginTop: 18 }]}>{detail.file.format} · {fileSize(detail.file.size)}</Text><Text style={[s.dialogNote, { color: c.quiet }]}>{t(detail.file.available === false ? 'The file was deleted. Original tool results are still retained.' : 'File saved. Query its structure with local rxd; the input is never executed.')}</Text></View> : <Text selectable style={[s.code, { color: c.text }]}>{t("File: {name}\nSize: {size} bytes\nSHA-256:\n{sha256}\n\nOn-device URI:\n{uri}", { name: detail.file.name, size: detail.file.size, sha256: detail.file.sha256, uri: detail.file.uri })}</Text>)}
          {detail?.kind === 'artifact' && (tab === 'preview' ? <RichText content={detail.artifact.content} c={c} /> : <Text selectable style={[s.code, { color: c.text }]}>{detail.artifact.content}</Text>)}
          {detail?.kind === 'tool' && <>{tab === 'preview' && detail.record ? recordPreview(detail.record as Record<string, unknown>, detail.file) : <CodeBlock code={tab === 'raw' ? JSON.stringify({ ...(detail.record ? { selectedEntity: detail.record } : {}), arguments: detail.tool.arguments, result: detail.tool.details }, null, 2) : detail.tool.text} language={tab === 'raw' ? 'json' : undefined} c={c} textStyle={s.code} />}{detail.file && <View style={{ marginTop: 24 }}><Text style={[s.caption, { color: c.quiet, marginBottom: 12 }]}>{t("Matching import snapshot")}</Text>{fileChip(detail.file)}</View>}</>}
        </ScrollView>
        <View style={[s.detailFooter, { borderTopColor: c.line }]}>
          <Pressable accessibilityRole="button" accessibilityLabel={t("Copy the current content")} onPress={() => { const text = detail?.kind === 'file' ? detail.file.source ?? detail.file.sha256 : detail?.kind === 'artifact' ? detail.artifact.content : detail?.record ? JSON.stringify(detail.record, null, 2) : detail?.tool.text ?? ''; void Clipboard.setStringAsync(text).then(() => setNotice(t("Copied"))); }} style={({ pressed }) => [s.footerButton, { borderColor: c.line }, pressed && { opacity: .55 }]}><Icon name="copy" color={c.quiet} size={17} /><Text style={[s.caption, { color: c.text }]}>{t("Copy")}</Text></Pressable>
          {detail?.kind === 'artifact' && <Pressable accessibilityRole="button" accessibilityLabel={t("Save to library")} accessibilityState={{ busy: savingArtifact }} disabled={!workspace || savingArtifact} onPress={() => { setSavingArtifact(true); void perform(async () => { await workspace!.saveReport(detail.artifact.turnId); setSavedArtifactId(detail.artifact.id); setNotice(t("Saved to library")); }).finally(() => setSavingArtifact(false)); }} style={({ pressed }) => [s.footerButton, { borderColor: c.line, opacity: savingArtifact ? .5 : pressed ? .55 : 1 }]}><Icon name="save" color={c.quiet} size={17} /><Text style={[s.caption, { color: c.text }]}>{t(savingArtifact ? 'Saving' : savedArtifactId === detail.artifact.id ? 'Saved' : 'Save to library')}</Text></Pressable>}
          {detail?.kind === 'artifact' ? <Pressable accessibilityRole="button" accessibilityLabel={t("Share the analysis artifact")} testID="share-artifact" onPress={() => { void share(detail.artifact); }} style={({ pressed }) => [s.footerButton, { backgroundColor: c.accent, borderColor: c.accent, flex: 1, opacity: pressed ? .82 : 1 }]}><Icon name="share" color={c.onAccent} size={17} /><Text style={[s.caption, { color: c.onAccent }]}>{t("Share artifact")}</Text></Pressable> : <Pressable accessibilityRole="button" accessibilityLabel={t("Ask a follow-up about this evidence")} onPress={() => { if (detail?.kind === 'file' && detail.file.available !== false) setPending(detail.file); else if (detail?.kind === 'tool' && detail.file?.available !== false && detail.file) setPending(detail.file); else setPending(null); setDraft('继续核对这个文件的结构与引用关系。'); setDetail(null); setTimeout(() => input.current?.focus(), 150); }} style={({ pressed }) => [s.footerButton, { backgroundColor: c.accent, borderColor: c.accent, flex: 1, opacity: pressed ? .82 : 1 }]}><Icon name="chat" color={c.onAccent} size={17} /><Text style={[s.caption, { color: c.onAccent }]}>{t("Ask a follow-up")}</Text></Pressable>}
        </View>
      </SafeAreaView>}
    </MotionModal>
    <MotionModal page value={profileOpen ? true : null} onClose={() => { if (!profileBusy) setProfileOpen(false); }}>{() => profileDraft &&
      <SafeAreaView edges={['top', 'bottom']} style={[s.screen, { backgroundColor: c.background }]}>
        <View style={s.profileHeader}><Pressable accessibilityRole="button" accessibilityLabel={t("Close")} onPress={() => { if (!profileBusy) setProfileOpen(false); }} style={({ pressed }) => [s.iconButton, pressed && { opacity: .55 }]}><Icon name="close" color={c.text} /></Pressable><Text style={[type.heading, { color: c.heading, flex: 1 }]}>{t("Local user")}</Text></View>
        <ScrollView contentContainerStyle={s.profileBody} keyboardShouldPersistTaps="handled">
          <View style={s.profileAvatarWrap}>
            <LocalAvatar name={profileDraft.name} uri={profileDraft.pending?.uri ?? profileDraft.avatar?.uri} c={c} size={78} />
            <Pressable accessibilityRole="button" accessibilityLabel={t("Change avatar")} testID="profile-avatar-change" onPress={() => { void chooseAvatar(); }} style={({ pressed }) => [s.profileAvatarAction, pressed && { opacity: .55 }]}><Text style={[type.label, { color: c.accent }]}>{t("Change avatar")}</Text></Pressable>
          </View>
          <Text style={[type.eyebrow, { color: c.faint }]}>{t("Name")}</Text>
          <TextInput testID="profile-name" accessibilityLabel={t("Name")} value={profileDraft.name} onChangeText={(name) => setProfileDraft((old) => old ? { ...old, name } : old)} maxLength={40} autoCorrect={false} placeholder={t("Stranger")} placeholderTextColor={c.faint} style={[s.profileInput, { color: c.text, backgroundColor: c.raised }]} />
          {!!profileError && <Text style={[type.caption, { color: c.danger }]}>{profileError}</Text>}
          <Pressable accessibilityRole="button" accessibilityLabel={t("Save profile")} testID="profile-save" disabled={profileBusy} onPress={() => { void saveProfile(); }} style={({ pressed }) => [s.profileSave, { backgroundColor: c.accent }, pressed && { opacity: .82 }, profileBusy && { opacity: .4 }]}><Text style={[type.label, { color: c.onAccent }]}>{t("Save profile")}</Text></Pressable>
        </ScrollView>
      </SafeAreaView>
    }</MotionModal>
    {!!notice && <FadeIn pointerEvents="none" style={[s.toast, { backgroundColor: c.surface, borderColor: c.accentLine }]}><Text style={[s.caption, { color: c.heading }]}>{t(notice)}</Text></FadeIn>}
  </SafeAreaView></KeyboardAvoidingView>;
}

const s = StyleSheet.create({
  previewName: { ...type.title, marginBottom: 8 }, codeFrame: { borderWidth: 1, borderRadius: 14, padding: 16, marginBottom: 16 },
  screen: { flex: 1 }, header: { flexDirection: 'row', alignItems: 'center', minHeight: 64, paddingHorizontal: 10, gap: 4 },
  iconButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 22 },
  headerCapsule: { flexDirection: 'row', alignItems: 'center', height: 44, marginRight: 8 },
  headerSegment: { width: 46, height: 42, alignItems: 'center', justifyContent: 'center', borderRadius: 22 },
  headerDivider: { width: 1, height: 12, alignSelf: 'center' },
  modelButton: { flexDirection: 'row', alignItems: 'center', gap: 3, minHeight: 44, paddingHorizontal: 10, borderRadius: 22, marginLeft: 2, flexShrink: 1 }, modelLabel: { flexDirection: 'row', alignItems: 'center', flexShrink: 1 }, modelName: { ...type.nav },
  modelArrow: { width: 18, height: 22, alignItems: 'center', justifyContent: 'center' },
  modelArrowRight: { transform: [{ translateY: 1.2 }] },
  modelLayer: { position: 'absolute', left: 0, right: 0, bottom: 0, zIndex: 20 }, modelLayerBody: { flex: 1, paddingHorizontal: 20, paddingTop: 18, paddingBottom: 24 },
  layerLabel: { ...type.eyebrow, marginBottom: 4 }, layerRow: { minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 20, marginHorizontal: -20 },
  layerMeta: { flex: 1, flexDirection: 'row', alignItems: 'baseline', gap: 8 }, layerTitle: { ...type.list }, layerCaption: { ...type.micro },
  modelList: { flex: 1, marginTop: 2 }, modelListBody: { paddingBottom: 8 }, thinkInline: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingLeft: 28, paddingBottom: 10 }, thinkLabel: { ...type.eyebrow }, thinkScroll: { flex: 1 }, thinkRow: { flexDirection: 'row', alignItems: 'center', gap: 2, paddingRight: 6 }, thinkItem: { minHeight: 40, flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 6 }, thinkText: { ...type.label }, manageModels: { marginTop: 10 },
  menuCheckSlot: { width: 16, height: 16 },
  welcomeContent: { flexGrow: 1, justifyContent: 'center' }, welcome: { alignItems: 'center', paddingHorizontal: 22, paddingBottom: 45 },
  heroMark: { marginBottom: 27 }, greeting: { ...type.label, marginBottom: 15 },
  heroTitle: { ...type.display },
  composeArea: { paddingHorizontal: 13, paddingTop: 7, paddingBottom: 12, flexShrink: 1 },
  branchBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 12, minHeight: 36 },
  branchButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
composer: { borderRadius: 29, borderWidth: 1, padding: 7, flexShrink: 1 }, composerRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 3, flexShrink: 1 },
  composerAttachments: { flexGrow: 0, flexShrink: 1, minHeight: 44 },
  composerToolbar: { flexDirection: 'row', alignItems: 'center', gap: 3, paddingLeft: 1, paddingBottom: 1 },
  composerActions: { flexDirection: 'row', alignItems: 'center' }, input: { ...type.body, flex: 1, paddingVertical: 10, paddingHorizontal: 3, textAlignVertical: 'center' },
  composerIcon: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 20 },
  sendButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 22, marginLeft: 2 },
  skillChip: { flexDirection: 'row', alignItems: 'center', gap: 7, minHeight: 34, borderWidth: 1, borderRadius: 17, paddingHorizontal: 10 },
  pending: { marginHorizontal: 8, marginTop: 4, marginBottom: 7, flexDirection: 'row', alignItems: 'center', gap: 9, borderWidth: 1, borderRadius: 13, paddingLeft: 12 }, returnTask: { flexDirection: 'row', gap: 8, alignItems: 'center', padding: 9 },
  compaction: { flexDirection: 'row', alignItems: 'center', gap: 9, marginHorizontal: 20, padding: 10, borderWidth: 1, borderRadius: 12 }, compactionStop: { minWidth: 40, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  transcript: { paddingHorizontal: 20, paddingTop: 5, paddingBottom: 22 }, turn: { marginBottom: 34 },
  answerRow: { flexDirection: 'row', alignItems: 'flex-end' }, caret: { width: 7, height: 15, borderRadius: 2, marginLeft: 5, marginBottom: 22 }, userTurn: { alignItems: 'flex-end', gap: 9, marginTop: 12, marginBottom: 29 }, userBubble: { maxWidth: '94%', paddingVertical: 12, paddingHorizontal: 16, borderRadius: 21, borderTopRightRadius: 5 }, userEdit: { flexDirection: 'row', alignItems: 'center', gap: 5, minHeight: 32, paddingHorizontal: 3 }, inlineEdit: { width: '94%', borderWidth: 1, borderRadius: 18, padding: 12, gap: 8 }, inlineInput: { maxHeight: 180, textAlignVertical: 'top' }, inlineActions: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 14 }, inlineAction: { minHeight: 36, justifyContent: 'center', paddingHorizontal: 4 }, body: { ...type.body }, caption: { ...type.caption }, tiny: { ...type.micro },
  fileChip: { flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, borderRadius: 13, paddingVertical: 10, paddingHorizontal: 13, maxWidth: '100%' }, fileName: { ...type.mono },
  assistantHeading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-start', gap: 5, marginBottom: 12 },
  running: { paddingVertical: 8, gap: 8, marginBottom: 17 }, runningTitle: { ...type.heading }, trace: { borderBottomWidth: 1, paddingBottom: 15, marginBottom: 22 }, traceSummary: { flexDirection: 'row', alignItems: 'center', gap: 7, minHeight: 34 },
  traceChevronOpen: { transform: [{ rotate: '180deg' }] },
  traceRow: { flexDirection: 'row', alignItems: 'center', gap: 9, minHeight: 44, paddingLeft: 2 },
  sectionTitle: { ...type.section, marginTop: 6, marginBottom: 13 }, evidence: { borderWidth: 1, borderRadius: 11, padding: 13, marginBottom: 9, gap: 5 }, evidenceName: { ...type.mono },
  errorBar: { marginHorizontal: 15, padding: 11, borderRadius: 10, marginBottom: 8 }, moreHistory: { padding: 12, alignItems: 'center' },
  // Stays above the model/quick menu layer (zIndex 20): zIndex beats sibling order,
  // so a menu left open would otherwise cover the drawer body below the header.
  drawerOverlay: { flex: 1, flexDirection: 'row', zIndex: 30 }, drawer: { height: '100%', paddingHorizontal: 15 }, drawerHeader: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingLeft: 4, paddingTop: 8, paddingBottom: 14 },
  drawerBrand: { ...type.title, fontSize: 29, lineHeight: 34, fontWeight: '600', letterSpacing: -0.9 },
  drawerBrandRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  drawerNewRow: { flexDirection: 'row', alignItems: 'center', gap: 18, minHeight: 52, marginHorizontal: -15, paddingHorizontal: 31, marginBottom: 8 },
  drawerNewText: { ...type.rowLarge, fontWeight: '500' },
  drawerNav: { gap: 2, marginBottom: 22 },
  drawerRow: { flexDirection: 'row', alignItems: 'center', gap: 18, minHeight: 58, paddingHorizontal: 16, borderRadius: 29 },
  drawerRowLabel: { ...type.rowLarge },
  drawerBadge: { ...type.caption, marginLeft: -8 },
  drawerSection: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 6, marginBottom: 8 },
  drawerSessionActions: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  drawerSearchButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  drawerSectionLabel: { ...type.sectionLabel, fontWeight: '500' },
  drawerCount: { ...type.sectionLabel },
  historyItem: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 56, paddingVertical: 14, paddingHorizontal: 14, borderRadius: 14, marginBottom: 2 },
  historyTitle: { ...type.rowLarge, flex: 1 },
  historyAccent: { position: 'absolute', left: 0, top: 11, bottom: 11, width: 2.5, borderRadius: 2 },
  emptyHistory: { ...type.caption, paddingHorizontal: 6, paddingVertical: 13 },
  drawerFloor: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  drawerFooter: { position: 'absolute', left: 0, right: 0, bottom: 0, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, paddingHorizontal: 14, paddingBottom: 30, paddingTop: 20 },
  drawerAvatarButton: { minHeight: 54, alignItems: 'center', justifyContent: 'center', paddingRight: 8 },
  drawerSettings: { width: 54, height: 54, alignItems: 'center', justifyContent: 'center' },
  sheetRow: { flexDirection: 'row', alignItems: 'center', gap: 11, borderWidth: 1, borderRadius: 12, paddingHorizontal: 13, paddingVertical: 11, marginBottom: 8 },
  sheetOverlay: { flex: 1, justifyContent: 'flex-end' }, sheet: { maxHeight: '86%', borderTopLeftRadius: 25, borderTopRightRadius: 25, paddingBottom: 12 }, sheetHeader: { flexDirection: 'row', alignItems: 'center', paddingTop: 12, paddingHorizontal: 22, gap: 10 }, sheetTitle: { ...type.heading, flex: 1 }, sheetBody: { paddingHorizontal: 24, paddingBottom: 25, paddingTop: 5 }, importOption: { flexDirection: 'row', alignItems: 'center', gap: 15, minHeight: 83, borderBottomWidth: 1 }, optionTitle: { ...type.list, marginBottom: 4 }, dialogNote: { ...type.caption, marginTop: 19 },   detailHeader: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 21, paddingVertical: 16 }, detailTitle: { ...type.heading, marginTop: 6 }, tabs: { flexDirection: 'row', gap: 24, paddingHorizontal: 22, borderBottomWidth: 1 }, tab: { borderBottomWidth: 2, paddingVertical: 12 }, detailBody: { padding: 23, paddingBottom: 45 }, code: { ...type.code }, detailFooter: { borderTopWidth: 1, padding: 18, flexDirection: 'row', gap: 10 }, footerButton: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 8, minHeight: 43, paddingHorizontal: 17, borderRadius: 23, borderWidth: 1 },
  profileHeader: { minHeight: 64, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 12 },
  profileBody: { padding: 20, paddingBottom: 48, gap: 10 },
  profileAvatarWrap: { alignItems: 'center', gap: 8, marginTop: 8 },
  profileAvatarAction: { minHeight: 44, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 8 },
  profileInput: { ...type.body, minHeight: 48, borderRadius: 12, paddingHorizontal: 14, marginBottom: 4 },
  profileSave: { minHeight: 50, borderRadius: 14, alignItems: 'center', justifyContent: 'center', marginTop: 12 },
  // Above the drawer (zIndex 30) so a notice stays readable if the drawer is open.
  toast: { position: 'absolute', zIndex: 40, bottom: 100, alignSelf: 'center', maxWidth: '88%', borderWidth: 1, borderRadius: 12, paddingVertical: 11, paddingHorizontal: 17 },
});
