package com.watchparty.app

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.focusGroup
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.SwipeToDismissBox
import androidx.compose.material3.SwipeToDismissBoxValue
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.material3.rememberSwipeToDismissBoxState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.key
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.zIndex
import kotlinx.coroutines.delay
import kotlin.math.roundToInt

/*
 * Up next in the player (see ui-redesign/queue): on a TV a panel over the right of the video, which keeps playing,
 * with a dialog of options for each video; on a phone a bottom sheet where videos are dragged into order and swiped
 * away. Only the host changes it; guests see the same list without the controls.
 */

/** What the player's Up next shows and does. [edit] is null for guests, who can only look. */
class UpNextScreen(
    val api: Api,
    val tv: Boolean,
    val code: String,
    val edit: ((String) -> Unit)?,
    /** Seconds into the video playing now. */
    val position: () -> Double,
    val onPlay: (MediaItem) -> Unit,
    val onAddVideos: () -> Unit,
    val onClose: () -> Unit,
)

private val PanelBg = Color(0xFF1A1422)
private val PlayingBg = Color(0xFF2B2234)
private val RemoveRed = Color(0xFF9A3F38)

@Composable
fun UpNext(screen: UpNextScreen, queue: Queue?, playing: MediaItem?) {
    val upcoming = queue?.upcoming(playing?.id).orEmpty()
    var options by remember { mutableStateOf<String?>(null) }
    if (screen.tv) TvUpNext(screen, upcoming, playing) { options = it } else PhoneUpNext(screen, upcoming, playing) { options = it }
    // The options follow the video while it moves; they close if it leaves Up next.
    val shown = options?.let { id -> upcoming.firstOrNull { it.id == id } }
    val edit = screen.edit
    if (shown != null && edit != null) {
        UpNextOptions(screen.api, shown, upcoming.indexOf(shown), upcoming.size, edit, onPlay = { options = null; screen.onPlay(shown) }, onClose = { options = null })
    }
}

// ---------- TV ----------

@OptIn(ExperimentalComposeUiApi::class)
@Composable
private fun TvUpNext(screen: UpNextScreen, upcoming: List<MediaItem>, playing: MediaItem?, onOptions: (String) -> Unit) {
    BackHandler(onBack = screen.onClose)
    val first = remember { FocusRequester() }
    Box(Modifier.fillMaxSize()) {
        // The video stays in view on the left; Back (or the left arrow, which goes nowhere) leaves it showing.
        Box(Modifier.fillMaxHeight().fillMaxWidth(0.375f).align(Alignment.CenterEnd).background(PanelBg)) {
            Column(
                Modifier
                    .fillMaxSize()
                    .focusProperties { exit = { FocusRequester.Cancel } }
                    .focusGroup()
                    .verticalScroll(rememberScrollState())
                    .padding(start = 24.dp, end = 24.dp, top = 36.dp, bottom = 24.dp),
            ) {
                Text("Up next", fontFamily = BarlowCondensed, fontWeight = FontWeight.Bold, fontSize = 30.sp, color = Color.White)
                Text(
                    listOfNotNull(plural(upcoming.size, "video"), totalLength(upcoming), "Party ${screen.code}").joinToString(" · "),
                    color = Muted,
                    fontSize = 13.sp,
                    modifier = Modifier.padding(top = 2.dp, bottom = 18.dp),
                )
                playing?.let { PlayingNow(screen, it) }
                Spacer(Modifier.height(10.dp))
                upcoming.forEachIndexed { i, item ->
                    key(item.id) {
                        TvRow(
                            screen.api, item,
                            modifier = if (i == 0) Modifier.focusRequester(first) else Modifier,
                            onClick = screen.edit?.let { { onOptions(item.id) } },
                        )
                    }
                }
                if (screen.edit != null) {
                    TvAction("Add videos", R.drawable.ic_plus, if (upcoming.isEmpty()) Modifier.focusRequester(first) else Modifier, screen.onAddVideos)
                    // Clears it in one go, as Clear does on the phone and the web.
                    if (upcoming.isNotEmpty()) TvAction("Clear Up next", R.drawable.ic_trash, Modifier) { screen.edit?.invoke(Protocol.queueClear()) }
                } else if (upcoming.isEmpty()) {
                    Text("Nothing in Up next yet.", color = Muted, fontSize = 14.sp, modifier = Modifier.padding(top = 12.dp))
                }
            }
        }
    }
    LaunchedEffect(Unit) { runCatching { first.requestFocus() } }
}

/** The video playing now, at the top of the list: not a row you can pick. */
@Composable
private fun PlayingNow(screen: UpNextScreen, media: MediaItem) {
    val tv = screen.tv
    val progress = rememberProgress(screen, media)
    Row(
        Modifier
            .fillMaxWidth()
            .then(if (tv) Modifier.clip(RoundedCornerShape(14.dp)) else Modifier)
            .background(PlayingBg)
            .padding(horizontal = if (tv) 12.dp else 16.dp, vertical = if (tv) 8.dp else 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        // No lead column: the rows below have no place numbers, so the pictures line up.
        Thumb(screen.api, media, progress)
        Column(Modifier.padding(start = 14.dp).weight(1f)) {
            Text("PLAYING NOW", color = Accent, fontSize = 10.sp, fontWeight = FontWeight.Bold, letterSpacing = 1.5.sp)
            Text(rowTitle(media), color = Color.White, fontWeight = FontWeight.SemiBold, fontSize = if (tv) 16.sp else 15.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            val length = media.duration
            val sub = showLine(media) ?: movieLine(media, withLength = false)
            Text(
                if (tv && length != null) listOfNotNull(sub.takeIf { it.isNotEmpty() }, "${minutes(screen.position())} of ${minutes(length)} m").joinToString(" · ") else sub,
                color = Muted,
                fontSize = 13.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

/** How far into [media] the party is, 0 to 1, updated every second; null if the length isn't known. */
@Composable
private fun rememberProgress(screen: UpNextScreen, media: MediaItem): Float? {
    val length = media.duration ?: return null
    var now by remember { mutableFloatStateOf(0f) }
    LaunchedEffect(media.id) {
        while (true) {
            now = (screen.position() / length).toFloat().coerceIn(0f, 1f)
            delay(1000)
        }
    }
    return now
}

/** A video in Up next on the TV: its picture, title and facts. White while the remote is on it. */
@Composable
private fun TvRow(api: Api, item: MediaItem, modifier: Modifier, onClick: (() -> Unit)?) {
    val interaction = remember { MutableInteractionSource() }
    val focused by interaction.collectIsFocusedAsState()
    val ep = item.episode
    Row(
        modifier
            .fillMaxWidth()
            .padding(vertical = 4.dp)
            .scale(if (focused) 1.03f else 1f)
            .clip(RoundedCornerShape(14.dp))
            .background(if (focused) FocusFill else Color.Transparent)
            // Guests can move through the list too, so it scrolls; OK just does nothing for them.
            .clickable(interactionSource = interaction, indication = null) { onClick?.invoke() }
            .padding(horizontal = 12.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Thumb(api, item, null)
        Column(Modifier.padding(start = 14.dp).weight(1f)) {
            // Its name, then "Severance S2 E3 · 52 m" for an episode (like the phone's rows), no place number.
            val title = rowTitle(item)
            val sub = showLine(item)?.let { s -> listOfNotNull(s, item.duration?.let(::runtime)).joinToString(" · ") } ?: movieLine(item, withLength = true)
            Text(title, color = if (focused) OnFocus else Color.White, fontWeight = FontWeight.SemiBold, fontSize = 16.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (sub.isNotEmpty()) Text(sub, color = if (focused) OnFocusMuted else Muted, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

/** A text row at the end of the TV list, like Add videos and Clear Up next. */
@Composable
private fun TvAction(label: String, icon: Int, modifier: Modifier, onClick: () -> Unit) {
    val interaction = remember { MutableInteractionSource() }
    val focused by interaction.collectIsFocusedAsState()
    Row(
        modifier
            .padding(top = 8.dp)
            .scale(if (focused) 1.04f else 1f)
            .clip(CircleShape)
            .background(if (focused) FocusFill else Color.Transparent)
            .clickable(interactionSource = interaction, indication = null, onClick = onClick)
            .padding(start = 12.dp, end = 20.dp, top = 10.dp, bottom = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.width(24.dp), contentAlignment = Alignment.Center) {
            Icon(painterResource(icon), contentDescription = null, tint = if (focused) OnFocus else Muted, modifier = Modifier.size(18.dp))
        }
        Spacer(Modifier.width(12.dp))
        Text(label, color = if (focused) OnFocus else Color.White.copy(alpha = 0.85f), fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
    }
}

// ---------- Phone ----------

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun PhoneUpNext(screen: UpNextScreen, upcoming: List<MediaItem>, playing: MediaItem?, onOptions: (String) -> Unit) {
    val edit = screen.edit
    ModalBottomSheet(
        onDismissRequest = screen.onClose,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = Panel,
    ) {
        Column(Modifier.verticalScroll(rememberScrollState()).navigationBarsPadding().padding(bottom = 16.dp)) {
            Row(Modifier.padding(start = 20.dp, end = 8.dp, bottom = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("Up next", color = Color.White, fontSize = 22.sp, fontWeight = FontWeight.SemiBold)
                    Text(listOfNotNull(plural(upcoming.size, "video"), totalLength(upcoming)).joinToString(" · "), color = Muted, fontSize = 13.sp)
                }
                if (edit != null && upcoming.isNotEmpty()) DialogButton("Clear") { edit(Protocol.queueClear()) }
            }
            playing?.let { PlayingNow(screen, it) }
            Spacer(Modifier.height(8.dp))
            if (upcoming.isEmpty() && edit == null) {
                Text("Nothing in Up next yet.", color = Muted, fontSize = 14.sp, modifier = Modifier.padding(horizontal = 20.dp, vertical = 12.dp))
            }
            PhoneRows(screen, upcoming, onOptions)
            if (edit != null) {
                Row(
                    Modifier
                        .padding(horizontal = 16.dp, vertical = 12.dp)
                        .fillMaxWidth()
                        .heightIn(min = 48.dp)
                        .clip(CircleShape)
                        .background(Color.White.copy(alpha = 0.1f))
                        .clickable(onClick = screen.onAddVideos),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.Center,
                ) {
                    Icon(painterResource(R.drawable.ic_plus), contentDescription = null, tint = Color.White, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.width(8.dp))
                    Text("Add videos", color = Color.White, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
                }
            }
        }
    }
}

/**
 * The phone's Up next rows. The host drags a row by its handle to move it and swipes it left to remove it. While a
 * move goes to the server the rows keep the new order, so nothing jumps back.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun PhoneRows(screen: UpNextScreen, upcoming: List<MediaItem>, onOptions: (String) -> Unit) {
    val edit = screen.edit
    var moved by remember { mutableStateOf<List<String>?>(null) }
    LaunchedEffect(upcoming.map { it.id }) { moved = null }
    val byId = upcoming.associateBy { it.id }
    val rows = moved?.mapNotNull { byId[it] }?.takeIf { it.size == upcoming.size } ?: upcoming
    val current by rememberUpdatedState(rows)
    var dragging by remember { mutableStateOf<String?>(null) }
    var offset by remember { mutableFloatStateOf(0f) }
    var rowHeight by remember { mutableIntStateOf(1) }
    val from = rows.indexOfFirst { it.id == dragging }
    val to = if (from < 0) -1 else (from + (offset / rowHeight).roundToInt()).coerceIn(0, rows.lastIndex)
    rows.forEachIndexed { i, item ->
        key(item.id) {
            // Rows between where the dragged one started and where it is now make room for it.
            val shift = when {
                from < 0 || i == from -> 0f
                i in (from + 1)..to -> -rowHeight.toFloat()
                i in to until from -> rowHeight.toFloat()
                else -> 0f
            }
            val handle = if (edit == null) null else Modifier.pointerInput(item.id) {
                detectDragGestures(
                    onDragStart = { dragging = item.id; offset = 0f },
                    onDrag = { change, amount -> change.consume(); offset += amount.y },
                    onDragEnd = {
                        val start = current.indexOfFirst { it.id == item.id }
                        val end = (start + (offset / rowHeight).roundToInt()).coerceIn(0, current.lastIndex)
                        if (start >= 0 && end != start) {
                            moved = current.map { it.id }.toMutableList().apply { add(end, removeAt(start)) }
                            edit(Protocol.queueMove(item.id, end))
                        }
                        dragging = null
                        offset = 0f
                    },
                    onDragCancel = { dragging = null; offset = 0f },
                )
            }
            val lifted = i == from
            val row = Modifier
                .onSizeChanged { rowHeight = maxOf(1, it.height) }
                .zIndex(if (lifted) 1f else 0f)
                .graphicsLayer { translationY = if (lifted) offset else shift }
                .then(if (lifted) Modifier.shadow(8.dp) else Modifier)
            if (edit == null) {
                PhoneRow(screen.api, item, row, handle = null, onClick = null)
            } else {
                val swipe = rememberSwipeToDismissBoxState(confirmValueChange = { value ->
                    if (value == SwipeToDismissBoxValue.EndToStart) edit(Protocol.queueRemove(item.id))
                    value == SwipeToDismissBoxValue.EndToStart
                })
                SwipeToDismissBox(
                    state = swipe,
                    modifier = row,
                    enableDismissFromStartToEnd = false,
                    backgroundContent = {
                        Box(Modifier.fillMaxSize().background(RemoveRed).padding(end = 24.dp), contentAlignment = Alignment.CenterEnd) {
                            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                                Icon(painterResource(R.drawable.ic_trash), contentDescription = null, tint = Color.White, modifier = Modifier.size(22.dp))
                                Text("Remove", color = Color.White, fontSize = 12.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 4.dp))
                            }
                        }
                    },
                ) {
                    PhoneRow(screen.api, item, Modifier.background(Panel), handle, onClick = { onOptions(item.id) })
                }
            }
        }
    }
}

@Composable
private fun PhoneRow(api: Api, item: MediaItem, modifier: Modifier, handle: Modifier?, onClick: (() -> Unit)?) {
    Row(
        modifier
            .fillMaxWidth()
            .then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier)
            .padding(start = 16.dp, end = 4.dp, top = 8.dp, bottom = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Thumb(api, item, null)
        Column(Modifier.padding(start = 14.dp).weight(1f)) {
            Text(rowTitle(item), color = Color.White, fontWeight = FontWeight.SemiBold, fontSize = 15.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            val sub = showLine(item)?.let { s -> listOfNotNull(s, item.duration?.let(::runtime)).joinToString(" · ") } ?: movieLine(item, withLength = true)
            if (sub.isNotEmpty()) Text(sub, color = Muted, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        if (handle != null) {
            Box(handle.size(48.dp), contentAlignment = Alignment.Center) {
                Icon(painterResource(R.drawable.ic_grip), contentDescription = "Drag to move", tint = Muted, modifier = Modifier.size(20.dp))
            }
        }
    }
}

// ---------- Options (host) ----------

/**
 * OK on a video in Up next (or a tap on a phone): play it now, move it, or take it out. Moving keeps the dialog
 * open, so Move up can be pressed a few times in a row.
 */
@Composable
private fun UpNextOptions(api: Api, item: MediaItem, index: Int, count: Int, edit: (String) -> Unit, onPlay: () -> Unit, onClose: () -> Unit) {
    val first = remember { FocusRequester() }
    Dialog(onDismissRequest = onClose, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Column(
            Modifier
                .padding(24.dp)
                .widthIn(max = 380.dp)
                .clip(RoundedCornerShape(28.dp))
                .background(DialogSurface)
                .padding(horizontal = 16.dp, vertical = 20.dp),
        ) {
            Row(Modifier.padding(start = 8.dp, end = 8.dp, bottom = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                Thumb(api, item, null)
                Column(Modifier.padding(start = 14.dp)) {
                    Text(rowTitle(item), color = Color.White, fontSize = 20.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    Text("${ordinal(index + 1)} in Up next", color = Muted, fontSize = 13.sp)
                }
            }
            OptionRow(R.drawable.ic_play_filled, "Play now for everyone", Modifier.focusRequester(first), onClick = onPlay)
            OptionRow(R.drawable.ic_arrow_up, "Move up", enabled = index > 0) { edit(Protocol.queueMove(item.id, index - 1)) }
            OptionRow(R.drawable.ic_arrow_down, "Move down", enabled = index < count - 1) { edit(Protocol.queueMove(item.id, index + 1)) }
            OptionRow(R.drawable.ic_trash, "Remove from Up next", danger = true) { edit(Protocol.queueRemove(item.id)); onClose() }
        }
    }
    LaunchedEffect(Unit) { runCatching { first.requestFocus() } }
}

/** A row in a dialog's list: a pill that turns white with dark text while the remote is on it, as in Settings. */
@Composable
internal fun OptionRow(icon: Int, label: String, modifier: Modifier = Modifier, enabled: Boolean = true, danger: Boolean = false, onClick: () -> Unit) {
    val interaction = remember { MutableInteractionSource() }
    val focused by interaction.collectIsFocusedAsState()
    val color = when {
        focused -> OnFocus
        danger -> DangerText
        else -> Color.White
    }
    Row(
        modifier
            .fillMaxWidth()
            .scale(if (focused) 1.03f else 1f)
            .clip(RoundedCornerShape(24.dp))
            .background(if (focused) FocusFill else Color.Transparent)
            .clickable(interactionSource = interaction, indication = androidx.compose.material3.ripple(), enabled = enabled, onClick = onClick)
            .graphicsLayer { alpha = if (enabled) 1f else 0.38f }
            .heightIn(min = 48.dp)
            .padding(horizontal = 16.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(painterResource(icon), contentDescription = null, tint = color, modifier = Modifier.size(20.dp))
        Spacer(Modifier.width(16.dp))
        Text(label, color = color, fontSize = 16.sp, fontWeight = FontWeight.Medium)
    }
}

// ---------- Small parts ----------

/** A video's picture: the episode's still, else the backdrop or poster, with how far the party is along the bottom. */
@Composable
internal fun Thumb(api: Api, item: MediaItem, progress: Float?) {
    val m = item.meta
    val (path, size) = when {
        m?.stillPath != null -> m.stillPath to "w300"
        m?.backdropPath != null -> m.backdropPath to "w300"
        else -> m?.posterPath to "w342"
    }
    val image by produceState<ImageBitmap?>(null, path) { value = path?.let { api.image(it, size) } }
    Box(
        Modifier
            .width(96.dp)
            .height(54.dp)
            .clip(RoundedCornerShape(6.dp))
            .background(Brush.linearGradient(listOf(Color(0xFF3A3550), Color(0xFF1F1A29)))),
    ) {
        image?.let { Image(it, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize()) }
        if (progress != null) {
            Box(Modifier.align(Alignment.BottomStart).fillMaxWidth().height(3.dp).background(Color.Black.copy(alpha = 0.5f)))
            Box(Modifier.align(Alignment.BottomStart).fillMaxWidth(progress).height(3.dp).background(Accent))
        }
    }
}

/** The episode's name, or the movie's title. */
private fun rowTitle(m: MediaItem): String = m.episode?.let { it.title ?: m.meta?.title } ?: m.meta?.title ?: m.title

/** "Severance S2 E3" for an episode; null for anything else. */
private fun showLine(m: MediaItem): String? = m.episode?.let { "${m.meta?.show ?: it.show} ${episodeLabel(it.season, it.episode)}" }

/** "Movie · 1995 · 2 h 50 m", or the kind of extra. */
private fun movieLine(m: MediaItem, withLength: Boolean): String = listOfNotNull(
    m.extra?.kind ?: "Movie",
    (m.meta?.year ?: m.year)?.toString(),
    if (withLength) m.duration?.let(::runtime) else null,
).joinToString(" · ")

/** "4 h 39 m" for everything in Up next, when the server knows every length. */
private fun totalLength(items: List<MediaItem>): String? =
    items.takeIf { it.isNotEmpty() && it.all { m -> m.duration != null } }?.sumOf { it.duration!! }?.let(::runtime)

private fun minutes(seconds: Double) = (seconds / 60).toInt()

/** 1 -> "1st", 12 -> "12th", 23 -> "23rd" */
internal fun ordinal(n: Int): String = "$n" + when {
    n % 100 in 11..13 -> "th"
    n % 10 == 1 -> "st"
    n % 10 == 2 -> "nd"
    n % 10 == 3 -> "rd"
    else -> "th"
}

// ---------- The countdown card ----------

/**
 * "Up next · in 4" while a binge counts down to its next video (from the credits, or the end): a small glass card in
 * the bottom-right corner over the video, like streaming services have (see ui-redesign/up-next-card). Play now has an
 * orange bar that fills as the countdown runs; Stay here keeps watching. Anyone can press them.
 */
@Composable
internal fun NextCard(api: Api, tv: Boolean, item: MediaItem, at: Long, total: Long, serverNow: () -> Long, onPlayNow: (() -> Unit)?, onStay: (() -> Unit)?, focusKey: Int = 0) {
    var left by remember(at) { mutableStateOf(at - serverNow()) }
    LaunchedEffect(at) {
        while (true) {
            left = at - serverNow()
            delay(100)
        }
    }
    val seconds = ((left + 999) / 1000).coerceAtLeast(0)
    val elapsed = if (total > 0) (1f - left.toFloat() / total).coerceIn(0f, 1f) else 0f
    val m = item.meta
    val path = m?.stillPath ?: m?.backdropPath
    val image by produceState<ImageBitmap?>(null, path) { value = path?.let { api.image(it, "w300") } }
    val play = remember { FocusRequester() }
    Row(
        Modifier
            .shadow(24.dp, RoundedCornerShape(if (tv) 18.dp else 14.dp))
            .clip(RoundedCornerShape(if (tv) 18.dp else 14.dp))
            .background(Color(0xD9100C15))
            .padding(start = if (tv) 9.dp else 10.dp, top = if (tv) 9.dp else 10.dp, bottom = if (tv) 9.dp else 10.dp, end = if (tv) 14.dp else 16.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(if (tv) 12.dp else 12.dp),
    ) {
        Box(
            Modifier
                .width(if (tv) 150.dp else 140.dp)
                .height(if (tv) 84.dp else 79.dp)
                .clip(RoundedCornerShape(if (tv) 8.dp else 8.dp))
                .background(Brush.linearGradient(listOf(Color(0xFF3A3550), Color(0xFF1F1A29)))),
        ) {
            image?.let { Image(it, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize()) }
        }
        Column(Modifier.widthIn(max = if (tv) 260.dp else 230.dp)) {
            Text(
                if (seconds > 0) "UP NEXT · IN $seconds" else "UP NEXT",
                color = Accent, fontSize = if (tv) 10.sp else 11.sp, fontWeight = FontWeight.Bold, letterSpacing = 1.5.sp,
            )
            Text(rowTitle(item), color = Color.White, fontFamily = BarlowCondensed, fontWeight = FontWeight.Bold, fontSize = if (tv) 21.sp else 21.sp, lineHeight = 24.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(showLine(item) ?: movieLine(item, withLength = false), color = Muted, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (onPlayNow != null || onStay != null) {
                Row(Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    onPlayNow?.let { NextCardButton("Play now", true, elapsed, tv, Modifier.focusRequester(play), it) }
                    onStay?.let { NextCardButton("Stay here", false, null, tv, Modifier, it) }
                }
            }
        }
    }
    // The host's remote starts on Play now; [focusKey] changing puts it back there (Up from the seek bar, or after the
    // controls hide).
    if (tv && onPlayNow != null) LaunchedEffect(focusKey) { runCatching { play.requestFocus() } }
}

@Composable
private fun NextCardButton(label: String, primary: Boolean, fill: Float?, tv: Boolean, modifier: Modifier, onClick: () -> Unit) {
    val interaction = remember { MutableInteractionSource() }
    val focused by interaction.collectIsFocusedAsState()
    // White when it's the main button or the remote is on it, like every focused control.
    val light = primary || focused
    Box(
        modifier
            .scale(if (focused) 1.06f else 1f)
            .height(36.dp)
            .clip(CircleShape)
            .background(if (light) Color(0xFFEEEAF3) else Color.White.copy(alpha = 0.12f))
            .clickable(interactionSource = interaction, indication = null, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Row(Modifier.padding(horizontal = if (primary) 16.dp else 14.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            if (primary) Icon(painterResource(R.drawable.ic_play_filled), contentDescription = null, tint = Color(0xFF18131F), modifier = Modifier.size(14.dp))
            Text(label, color = if (light) Color(0xFF18131F) else Color.White, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
        }
        // matchParentSize so the bar sizes to the button; fillMaxWidth alone measured against the whole row and stretched
        // the button as the countdown ran.
        if (fill != null) Box(Modifier.matchParentSize()) { Box(Modifier.align(Alignment.BottomStart).fillMaxWidth(fill).height(3.dp).background(Accent)) }
    }
}

// ---------- Skip intro ----------

/**
 * "Skip intro" / "Skip recap": a glass pill in the bottom-right corner while one is on (see ui-redesign/skip). On a TV
 * the remote starts on it (white, like every focused control), so one OK skips; [focusKey] changing puts it back there.
 */
@Composable
internal fun SkipPartButton(kind: String, tv: Boolean, focusKey: Int, onClick: () -> Unit) {
    val interaction = remember { MutableInteractionSource() }
    val focused by interaction.collectIsFocusedAsState()
    val focus = remember { FocusRequester() }
    Row(
        Modifier
            .focusRequester(focus)
            .scale(if (focused) 1.06f else 1f)
            .shadow(if (focused) 16.dp else 0.dp, CircleShape)
            .clip(CircleShape)
            .background(if (focused) Color(0xFFEEEAF3) else Color(0xB8100C15))
            .border(1.dp, if (focused) Color.Transparent else Color.White.copy(alpha = 0.16f), CircleShape)
            .clickable(interactionSource = interaction, indication = null, onClick = onClick)
            .height(if (tv) 44.dp else 42.dp)
            .padding(horizontal = if (tv) 20.dp else 18.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        val ink = if (focused) Color(0xFF18131F) else Color.White
        Icon(painterResource(R.drawable.ic_skip_forward), contentDescription = null, tint = ink, modifier = Modifier.size(16.dp))
        Text("Skip $kind", color = ink, fontSize = if (tv) 16.sp else 15.sp, fontWeight = FontWeight.SemiBold)
    }
    if (tv) LaunchedEffect(focusKey) { if (focusKey > 0) runCatching { focus.requestFocus() } }
}
