package com.watchparty.app

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import java.time.Instant
import java.time.ZoneId
import java.time.format.TextStyle
import java.time.temporal.ChronoUnit
import java.util.Locale

/*
 * "Pick up where you left off" (see ui-redesign/resume): when the host ends a party partway through something, they
 * can save its spot; Home lists the saved spots, and starting one opens a new party right there with the rest lined
 * up in Up next.
 */

/** What ending now would save: the video and how far in, and how many more are lined up after it. */
data class SpotPreview(val media: MediaItem, val position: Double, val more: Int)

/** At the credits with more lined up, the spot is the start of the next video (as the server saves it). */
fun spotPreview(media: MediaItem, position: Double, duration: Double?, next: MediaItem?, upcoming: Int): SpotPreview =
    if (nearEnd(position, duration, media.marks?.credits) && next != null) SpotPreview(next, 0.0, upcoming - 1) else SpotPreview(media, position, upcoming)

/** "Severance · S2 E3 Who Is Alive?", or the movie's title. */
fun spotTitle(m: MediaItem): String {
    val ep = m.episode ?: return m.meta?.title ?: m.title
    val name = m.meta?.title ?: ep.title
    return "${m.meta?.show ?: ep.show} · ${episodeLabel(ep.season, ep.episode)}" + (name?.let { " $it" } ?: "")
}

/** "Severance S2 E3", or the movie's title: for the phone's narrower cards. */
fun spotShortTitle(m: MediaItem): String =
    m.episode?.let { "${m.meta?.show ?: it.show} ${episodeLabel(it.season, it.episode)}" } ?: m.meta?.title ?: m.title

/** "31 m in", or "From the start" for a spot at the very beginning (the next one in a binge). */
fun howFar(position: Double): String = if (position >= 60) "${runtime(position)} in" else "From the start"

fun linedUp(n: Int): String? = if (n > 0) "$n more lined up" else null

/** Today, Yesterday, Tue, last week, 3 weeks ago. */
fun savedWhen(savedAt: Long, now: Long = System.currentTimeMillis(), zone: ZoneId = ZoneId.systemDefault()): String {
    val day = { t: Long -> Instant.ofEpochMilli(t).atZone(zone).toLocalDate() }
    val days = ChronoUnit.DAYS.between(day(savedAt), day(now))
    return when {
        days <= 0 -> "Today"
        days == 1L -> "Yesterday"
        days < 7 -> day(savedAt).dayOfWeek.getDisplayName(TextStyle.SHORT, Locale.getDefault())
        days < 14 -> "last week"
        else -> "${days / 7} weeks ago"
    }
}

/** "31 m in · 4 more lined up · Tue" */
fun spotFacts(s: Spot, withWhen: Boolean = true): String =
    listOfNotNull(howFar(s.position), linedUp(s.next.size), if (withWhen) savedWhen(s.savedAt) else null).joinToString(" · ")

private fun progress(media: MediaItem, position: Double): Float? =
    media.duration?.takeIf { it > 0 }?.let { (position / it).toFloat().coerceIn(0f, 1f) }

/**
 * Wide art for a spot: the episode's still, else the backdrop, else a still from the video where it stopped, with how far
 * in along the bottom. With no picture at all, the title over the gradient.
 */
@Composable
private fun SpotArt(api: Api, details: Boolean, s: Spot, modifier: Modifier) {
    val m = s.media.meta
    val path = if (details) m?.stillPath ?: m?.backdropPath else null
    // (loaded, picture): the title only shows once both pictures turned out missing, not while they load.
    val art by produceState<Pair<Boolean, ImageBitmap?>>(false to null, path, s.id) { value = true to (path?.let { api.image(it, "w780") } ?: api.spotFrame(s.id)) }
    val image = art.second
    Box(modifier.background(Brush.linearGradient(listOf(Color(0xFF3A3550), Color(0xFF1F1A29))))) {
        if (image != null) Image(image, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
        else if (art.first) Text(
                m?.show ?: s.media.episode?.show ?: m?.title ?: s.media.title,
                color = Color.White.copy(alpha = 0.85f), fontFamily = BarlowCondensed, fontWeight = FontWeight.Bold, fontSize = 20.sp, lineHeight = 22.sp,
                textAlign = TextAlign.Center, maxLines = 2, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.align(Alignment.Center).padding(horizontal = 14.dp),
            )
        progress(s.media, s.position)?.let { p ->
            Box(Modifier.align(Alignment.BottomStart).fillMaxWidth().height(4.dp).background(Color.White.copy(alpha = 0.25f)))
            Box(Modifier.align(Alignment.BottomStart).fillMaxWidth(p).height(4.dp).background(Accent))
        }
    }
}

/** A TV card: the art grows and gets a white edge while the remote is on it; OK opens [SpotOptions]. */
@Composable
fun TvSpotCard(api: Api, details: Boolean, s: Spot, width: Dp, onClick: () -> Unit) {
    val interaction = remember { MutableInteractionSource() }
    val focused by interaction.collectIsFocusedAsState()
    val shape = RoundedCornerShape(10.dp)
    Column(Modifier.width(width)) {
        SpotArt(
            api, details, s,
            Modifier
                .fillMaxWidth()
                .aspectRatio(16f / 9f)
                .scale(if (focused) 1.05f else 1f)
                .border(if (focused) 3.dp else 0.dp, if (focused) Color.White else Color.Transparent, shape)
                .clip(shape)
                .remembersFocus()
                .clickable(interactionSource = interaction, indication = null, onClick = onClick),
        )
        Text(spotTitle(s.media), color = Color.White, fontSize = 15.sp, lineHeight = 18.sp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = if (focused) 12.dp else 8.dp))
        Text(spotFacts(s, withWhen = false), color = Muted, fontSize = 12.sp, lineHeight = 15.sp, maxLines = 1, modifier = Modifier.padding(top = 2.dp))
    }
}

/** A phone card: tap it for the show or movie page, Start for a new party there, × to forget it. */
@Composable
fun PhoneSpotCard(api: Api, details: Boolean, s: Spot, width: Dp, onOpen: () -> Unit, onStart: () -> Unit, onRemove: () -> Unit) {
    val shape = RoundedCornerShape(16.dp)
    Column(Modifier.width(width).clip(shape).background(Panel).clickable(onClick = onOpen)) {
        Box {
            SpotArt(api, details, s, Modifier.fillMaxWidth().aspectRatio(2f))
            Box(
                Modifier.align(Alignment.TopEnd).padding(6.dp).size(36.dp).clip(CircleShape).clickable(onClick = onRemove),
                contentAlignment = Alignment.Center,
            ) {
                Box(Modifier.size(28.dp).clip(CircleShape).background(Color(0xCC0A070E)), contentAlignment = Alignment.Center) {
                    Icon(painterResource(R.drawable.ic_close), contentDescription = "Remove", tint = Color.White, modifier = Modifier.size(16.dp))
                }
            }
        }
        Row(Modifier.padding(start = 12.dp, top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(spotShortTitle(s.media), color = Color.White, fontWeight = FontWeight.SemiBold, fontSize = 15.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            Text("Start", color = Accent, fontWeight = FontWeight.SemiBold, fontSize = 14.sp, modifier = Modifier.clip(RoundedCornerShape(8.dp)).clickable(onClick = onStart).padding(horizontal = 12.dp, vertical = 4.dp))
        }
        Text(spotFacts(s, withWhen = false), color = Muted, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(start = 12.dp, end = 12.dp, bottom = 12.dp))
    }
}

/** On a show page with a saved spot: the episode's picture with how far in, and "S2 E3 Who Is Alive? · 31 m in · 4 more lined up · saved Tue". */
@Composable
fun SpotLine(api: Api, details: Boolean, s: Spot, tv: Boolean) {
    val m = s.media
    val name = m.episode?.let { e -> episodeLabel(e.season, e.episode) + ((m.meta?.title ?: e.title)?.let { " $it" } ?: "") } ?: m.meta?.title ?: m.title
    val saved = savedWhen(s.savedAt).let { if (it == "Today" || it == "Yesterday") it.lowercase() else it }
    Row(verticalAlignment = Alignment.CenterVertically) {
        if (details) Thumb(api, m, progress(m, s.position))
        Column(Modifier.padding(start = if (details) 14.dp else 0.dp)) {
            Text("Pick up where you left off", color = Color.White, fontWeight = FontWeight.SemiBold, fontSize = if (tv) 16.sp else 15.sp)
            Text(
                listOfNotNull(name, howFar(s.position), linedUp(s.next.size), "saved $saved").joinToString(" · "),
                color = Muted,
                fontSize = 13.sp,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

/** OK on a TV spot card: start a party there, go to its page, or forget it. */
@Composable
fun SpotOptions(api: Api, s: Spot, startLabel: String, onStart: () -> Unit, onOpen: () -> Unit, onRemove: () -> Unit, onClose: () -> Unit) {
    val first = remember { FocusRequester() }
    Dialog(onDismissRequest = onClose, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Column(
            Modifier
                .padding(24.dp)
                .widthIn(max = 400.dp)
                .clip(RoundedCornerShape(28.dp))
                .background(DialogSurface)
                .padding(horizontal = 16.dp, vertical = 20.dp),
        ) {
            Row(Modifier.padding(start = 8.dp, end = 8.dp, bottom = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                Thumb(api, s.media, progress(s.media, s.position))
                Column(Modifier.padding(start = 14.dp)) {
                    Text(spotTitle(s.media), color = Color.White, fontSize = 18.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    Text(spotFacts(s), color = Muted, fontSize = 13.sp)
                }
            }
            OptionRow(R.drawable.ic_play_filled, startLabel, Modifier.focusRequester(first), onClick = onStart)
            if (s.media.episode != null || s.media.extra?.show != null) OptionRow(R.drawable.ic_nav_shows, "Go to show", onClick = onOpen)
            else OptionRow(R.drawable.ic_nav_movies, "Go to movie", onClick = onOpen)
            OptionRow(R.drawable.ic_trash, "Remove", danger = true, onClick = onRemove)
        }
    }
    LaunchedEffect(Unit) { runCatching { first.requestFocus() } }
}

/**
 * "Save your spot?", asked when the host ends a party that's partway through something (the dashboard's End party).
 * Save spot has the focus.
 */
@Composable
fun SaveSpotDialog(api: Api, spot: SpotPreview, onSave: () -> Unit, onDontSave: () -> Unit, onCancel: () -> Unit) {
    val save = remember { FocusRequester() }
    Dialog(onDismissRequest = onCancel, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Column(
            Modifier
                .padding(24.dp)
                .widthIn(max = 460.dp)
                .clip(RoundedCornerShape(28.dp))
                .background(DialogSurface)
                .padding(24.dp),
        ) {
            Text("Save your spot?", color = Color.White, fontSize = 24.sp)
            Text(
                buildAnnotatedString {
                    append("The party ends for everyone. Saving puts this on Home under ")
                    withStyle(SpanStyle(color = Color.White, fontWeight = FontWeight.SemiBold)) { append("Pick up where you left off") }
                    append(", so you can start a new party right here later.")
                },
                color = Muted,
                fontSize = 14.sp,
                lineHeight = 20.sp,
                modifier = Modifier.padding(top = 16.dp, bottom = 16.dp),
            )
            val m = spot.media
            Row(
                Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(Color.White.copy(alpha = 0.05f)).padding(10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Thumb(api, m, progress(m, spot.position))
                Column(Modifier.padding(start = 14.dp)) {
                    Text(m.episode?.let { m.meta?.title ?: it.title } ?: m.meta?.title ?: m.title, color = Color.White, fontWeight = FontWeight.SemiBold, fontSize = 15.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(
                        listOfNotNull(m.episode?.let { "${m.meta?.show ?: it.show} · ${episodeLabel(it.season, it.episode)}" }, howFar(spot.position), linedUp(spot.more)).joinToString(" · "),
                        color = Muted,
                        fontSize = 13.sp,
                    )
                }
            }
            Row(Modifier.fillMaxWidth().padding(top = 24.dp), verticalAlignment = Alignment.CenterVertically) {
                DialogButton("Cancel", onClick = onCancel)
                Spacer(Modifier.weight(1f))
                DialogButton("Don't save", onClick = onDontSave)
                DialogButton("Save spot", modifier = Modifier.focusRequester(save), onClick = onSave)
            }
        }
    }
    LaunchedEffect(Unit) { runCatching { save.requestFocus() } }
}
