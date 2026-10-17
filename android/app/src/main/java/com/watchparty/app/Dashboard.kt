package com.watchparty.app

import android.app.UiModeManager
import android.content.res.Configuration
import androidx.activity.compose.BackHandler
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.relocation.BringIntoViewResponder
import androidx.compose.foundation.relocation.bringIntoViewResponder
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyGridState
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.composed
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.Key
import androidx.compose.runtime.DisposableEffect
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.withFrameNanos
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.listSaver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshots.SnapshotStateList
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.draw.scale
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.foundation.focusGroup
import androidx.compose.ui.focus.FocusDirection
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.toSize
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/*
 * The host's dashboard, laid out like Plex or Jellyfin, matching the web app: Home (the newest titles on a big
 * backdrop, running parties, rows of posters), Movies, TV shows and Watch parties, plus a page for each movie and show.
 * Phones get a Material 3 bottom bar; TVs get a slim icon menu on the left that opens when the remote moves onto it.
 */

/** Where the dashboard is: "home", "movies", "shows", "parties", "search", "movie/<id>" or "show/<name>". */
internal typealias Route = String

private const val TMDB_CREDIT = "Details and images from TMDB. This product uses the TMDB API but is not endorsed or certified by TMDB."
/** See-through white for tonal buttons and the selected menu item. */
private val Tonal = Color.White.copy(alpha = 0.14f)

/** Everything the pages need: the library grouped into movies and shows, and what each button does. */
private class Library(val items: List<MediaItem>) {
    val byId = items.associateBy { it.id }
    val movies = items.filter { it.episode == null && !it.ownedExtra && !it.laterPart }
    val shows = shows(items)
    val extras = extrasByOwner(items)
    /** The server found TMDB details for something, so posters and backdrops are worth drawing. */
    val details = items.any { it.meta != null }

    fun show(name: String) = shows.firstOrNull { it.name == name }

    /** The newest movies and shows that have background art, for the banner. */
    val featured: List<Featured> = (
        movies.filter { it.extra == null && it.meta?.backdropPath != null }.map { Featured(it.meta!!.title, movieFacts(it), it.meta.backdropPath!!, "movie/${it.id}", it, it.addedAt) } +
            shows.filter { it.meta?.backdropPath != null }.map { Featured(it.name, showFacts(it), it.meta!!.backdropPath!!, "show/${it.name}", null, it.addedAt) }
        ).sortedByDescending { it.addedAt }.take(5)

    /** Movies and shows together, newest first. */
    val recent: List<Any> = (movies.filter { it.extra == null }.map { it to it.addedAt } + shows.map { it to it.addedAt })
        .sortedByDescending { it.second }.take(16).map { it.first }

    /** "2015 · 2 h 0 m · ★ 7.6 · Action, Adventure · Subtitles" */
    fun movieFacts(m: MediaItem): String {
        val parts = m.part?.ids?.map { byId[it] }
        val length = if (parts != null) parts.takeIf { p -> p.all { it?.duration != null } }?.sumOf { it!!.duration!! } else m.duration
        return listOfNotNull(
            (m.meta?.year ?: m.year)?.toString(),
            if (m.part != null) "${m.part.ids.size} parts" + (length?.let { ", " + runtime(it) } ?: "") else length?.let(::runtime),
            m.meta?.rating?.let { "★ %.1f".format(it) },
            m.meta?.genres?.take(3)?.joinToString(", ")?.takeIf { it.isNotEmpty() },
            "Subtitles".takeIf { m.subtitles.isNotEmpty() },
        ).joinToString(" · ")
    }

    fun showFacts(s: Show): String = listOfNotNull(
        s.meta?.year?.toString(),
        // A show with only specials (or extras) has no "0 seasons".
        s.seasons.size.takeIf { it > 0 }?.let { plural(it, "season") },
        s.specials.size.takeIf { it > 0 }?.let { plural(it, "special") },
        s.meta?.rating?.let { "★ %.1f".format(it) },
        s.meta?.genres?.take(3)?.joinToString(", ")?.takeIf { it.isNotEmpty() },
    ).joinToString(" · ")
}

private data class Featured(val title: String, val facts: String, val backdrop: String, val route: Route, val movie: MediaItem?, val addedAt: Long)

/** 7260.0 -> "2 h 1 m", 3000.0 -> "50 m" */
internal fun runtime(seconds: Double): String {
    val m = Math.round(seconds / 60).toInt()
    return if (m >= 60) "${m / 60} h ${m % 60} m" else "${maxOf(1, m)} m"
}

/**
 * What the pages call: start a party, open a page or a video's details. While [adding] to a party's Up next
 * ("Add videos" in the player), [start] plays for everyone in that party instead, and [queue] adds to Up next.
 */
private class Actions(
    val api: Api,
    val tv: Boolean,
    val go: (Route) -> Unit,
    val start: (MediaItem, List<String>?) -> Unit,
    val info: (MediaItem) -> Unit,
    val join: (RoomSummary) -> Unit,
    val end: (RoomSummary) -> Unit,
    val adding: Boolean = false,
    /** Adds these videos to Up next; the text names them in the "Added" message. */
    val queue: (List<String>, String) -> Unit = { _, _ -> },
    /** The show's saved spot (Pick up where you left off), for Continue binge on its page. */
    val spotOf: (Show) -> Spot? = { null },
    val startSpot: (Spot) -> Unit = {},
    /** The Together / Alone switch is on Alone: Play starts just for the host. */
    val alone: Boolean = false,
    val setAlone: (Boolean) -> Unit = {},
) {
    val startLabel = if (adding) (if (PartyLink.solo) "Play" else "Play for everyone") else if (alone) "Play" else "Start party"
}

/**
 * The host's home. Replaces the old single list; [onSignedOut] goes back to the sign-in screen (Settings). With
 * [adding], it's the library for the open party's Up next ([AddVideosActivity]), and [onBackToParty] returns to it.
 */
@Composable
fun Dashboard(prefs: Prefs, onSignedOut: (String?) -> Unit, adding: Boolean = false, onBackToParty: () -> Unit = {}, forceTv: Boolean = false) {
    val api = remember { Api(prefs.serverUrl, prefs.token) }
    val context = LocalContext.current
    // forceTv: the TV layout without a TV, for the screen tests.
    val tv = remember {
        forceTv || context.getSystemService(UiModeManager::class.java)?.currentModeType == Configuration.UI_MODE_TYPE_TELEVISION
    }
    val scope = rememberCoroutineScope()
    var rooms by remember { mutableStateOf<List<RoomSummary>>(emptyList()) }
    var started by remember { mutableStateOf<RoomSummary?>(null) }
    var items by remember { mutableStateOf<List<MediaItem>?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var shownInfo by rememberSaveable { mutableStateOf<String?>(null) }
    var ending by remember { mutableStateOf<RoomSummary?>(null) }
    // Pick up where you left off, and the one whose options are open on a TV.
    var spots by remember { mutableStateOf<List<Spot>>(emptyList()) }
    var spotOptions by remember { mutableStateOf<Spot?>(null) }
    /** On a TV, where the removed spot was, so the remote lands on its neighbor instead of falling into the side menu. */
    var removedAt by remember { mutableStateOf<Int?>(null) }
    var askCode by remember { mutableStateOf(false) }
    // Together / Alone: remembered on this device.
    var alone by remember { mutableStateOf(prefs.alone) }
    val setAlone = { on: Boolean ->
        alone = on
        prefs.alone = on
        if (!tv) android.widget.Toast.makeText(context, if (on) "Watching alone" else "Watching together", android.widget.Toast.LENGTH_SHORT).show()
    }

    // Pages opened so far; Back returns to the one before. Kept through rotation.
    val stack: SnapshotStateList<Route> = rememberSaveable(saver = listSaver(save = { it.toList() }, restore = { mutableStateListOf(*it.toTypedArray()) })) {
        mutableStateListOf("home")
    }
    val route = stack.last()
    val go: (Route) -> Unit = { r ->
        // The menu's pages replace each other; movie and show pages stack on top so Back returns.
        if (r == "back") {
            if (stack.size > 1) stack.removeAt(stack.lastIndex) else stack[0] = "home"
        } else if (r in TOP_PAGES) {
            stack.clear()
            stack.add(r)
        } else if (r != route) stack.add(r)
    }
    BackHandler(enabled = stack.size > 1 || route != "home") {
        if (stack.size > 1) stack.removeAt(stack.lastIndex) else stack[0] = "home"
    }
    // Each page keeps its scroll position, so Back from a movie lands where you were.
    val listStates = remember { mutableMapOf<Route, LazyListState>() }
    val gridStates = remember { mutableMapOf<Route, LazyGridState>() }
    val listState = listStates.getOrPut(route) { LazyListState() }
    val gridState = gridStates.getOrPut(route) { LazyGridState() }

    suspend fun <T> guard(block: suspend () -> T): T? = try {
        block()
    } catch (e: UnauthorizedException) {
        onSignedOut("Signed out. Check the server password.")
        null
    } catch (e: Exception) {
        error = e.message ?: "Couldn't reach the server."
        null
    }
    val reload = { scope.launch { guard { api.library() }?.let { items = it; error = null } } }
    LaunchedEffect(Unit) { reload() }
    var fetchedAt by remember { mutableStateOf(0L) }
    var now by remember { mutableStateOf(0L) }
    LaunchedEffect(Unit) {
        // While adding to a party, the parties aren't shown: picking one would open a second player.
        while (!adding) {
            guard { api.rooms() }?.let {
                rooms = it
                fetchedAt = System.currentTimeMillis()
                now = fetchedAt
            }
            // Parties ended in the player, or that closed by themselves, may have saved a spot.
            guard { api.spots() }?.let { spots = it }
            delay(5000)
        }
    }
    // Between refreshes, move playing parties' progress along once a second.
    val anyPlaying = rooms.any { it.playback?.paused == false }
    LaunchedEffect(anyPlaying) {
        while (anyPlaying) {
            delay(1000)
            now = System.currentTimeMillis()
        }
    }

    val library = remember(items) { items?.let(::Library) }
    // "Added … to Up next", with Undo, at the bottom of a phone; a TV shows a toast.
    var added by remember { mutableStateOf<Pair<String, List<String>>?>(null) }
    LaunchedEffect(added) {
        if (added != null) {
            delay(4000)
            added = null
        }
    }
    val spotActions = SpotActions(
        start = { spot ->
            spotOptions = null
            scope.launch {
                val room = guard { api.startSpot(spot.id, alone) }
                spots = spots.filter { it.id != spot.id }
                // Watching alone goes straight to the player; a party shows its code first.
                if (room?.solo == true) RoomActivity.start(context, room.id)
                else if (room != null) {
                    started = room
                    rooms = rooms.filter { it.id != room.id } + room
                    listState.scrollToItem(0)
                } else guard { api.spots() }?.let { spots = it }
            }
        },
        open = { spot ->
            spotOptions = null
            val m = spot.media
            // An extra opens the show or movie it belongs to.
            val show = m.episode?.let { library?.shows?.firstOrNull { s -> s.episodes.any { it.id == m.id } } }
                ?: m.extra?.show?.let { name -> library?.shows?.firstOrNull { name in it.aliases } }
            go(if (show != null) "show/${show.name}" else "movie/${m.extra?.of ?: m.id}")
        },
        remove = { spot ->
            spotOptions = null
            removedAt = spots.indexOfFirst { it.id == spot.id }
            spots = spots.filter { it.id != spot.id }
            scope.launch { guard { api.removeSpot(spot.id) } ?: guard { api.spots() }?.let { spots = it } }
        },
        options = { spotOptions = it },
    )
    val party = PartyLink.party
    val actions = if (adding) Actions(
        api = api,
        tv = tv,
        go = go,
        start = { media, queue ->
            val ids = queue ?: listOf(media.id)
            party?.send?.invoke(if (ids.size > 1) Protocol.binge(ids) else Protocol.select(ids[0]))
            onBackToParty()
        },
        info = { shownInfo = it.id },
        join = {},
        end = {},
        adding = true,
        queue = { ids, label ->
            party?.send?.invoke(Protocol.queueAdd(ids))
            if (tv) android.widget.Toast.makeText(context, "Added to Up next", android.widget.Toast.LENGTH_SHORT).show()
            else added = label to ids
        },
    ) else Actions(
        api = api,
        tv = tv,
        go = go,
        start = { media, queue ->
            scope.launch {
                guard { api.createRoom(media.id, queue, alone) }?.let { room ->
                    if (room.solo) return@let RoomActivity.start(context, room.id)
                    started = room
                    rooms = rooms.filter { it.id != room.id } + room
                    listState.scrollToItem(0)
                }
            }
        },
        info = { shownInfo = it.id },
        join = { RoomActivity.start(context, it.id) },
        end = { ending = it },
        spotOf = { show -> spots.firstOrNull { sp -> show.episodes.any { it.id == sp.media.id } } },
        startSpot = { spotActions.start(it) },
        alone = alone,
        setAlone = setAlone,
    )
    val sinceFetch = (now - fetchedAt).coerceAtLeast(0)

    val page: @Composable () -> Unit = {
        val lib = library
        val movie = route.removePrefix("movie/").takeIf { route.startsWith("movie/") }?.let { lib?.byId?.get(it) }
        val show = route.removePrefix("show/").takeIf { route.startsWith("show/") }?.let { lib?.show(it) }
        when {
            route == "settings" -> SettingsPage(prefs, tv, onSignOut = { onSignedOut(null) })
            route == "parties" -> PartiesPage(rooms, sinceFetch, lib?.details == true, actions, gridState)
            lib == null -> Message(error ?: "Loading library…", error != null)
            lib.items.isEmpty() -> Message("No videos found. Put files in the server's media folder.", false)
            movie != null -> MoviePage(lib, movie, actions, listState)
            show != null -> ShowPage(lib, show, actions, listState)
            route == "movies" -> PosterGrid(lib, "Movies", lib.movies, emptyList(), actions, gridState, sortable = true)
            route == "shows" -> PosterGrid(lib, "TV Shows", emptyList(), lib.shows, actions, gridState, sortable = true)
            route == "search" -> SearchPage(lib, actions, gridState)
            route.startsWith("movie/") || route.startsWith("show/") -> Message("That isn't in the library anymore.", false)
            else -> HomePage(lib, rooms, if (adding) emptyList() else spots, spotActions, sinceFetch, started, error, actions, listState, onDismissStarted = { started = null }, removedAt = removedAt, onRefocused = { removedAt = null })
        }
    }

    if (tv) {
        TvShell(route, adding, alone, setAlone, onCode = { askCode = true }, onRefresh = { reload() }, onSettings = { go("settings") }, go = go) {
            Box(Modifier.fillMaxSize()) {
                page()
                if (adding) PartyPill(tv = true, Modifier.align(Alignment.TopEnd).padding(top = 24.dp, end = 32.dp), onBackToParty)
            }
        }
    } else {
        PhoneShell(route, adding, alone, setAlone, onCode = { askCode = true }, onRefresh = { reload() }, onSettings = { go("settings") }, onBack = onBackToParty, go = go) {
            Box(Modifier.fillMaxSize()) {
                page()
                // The top pages show it in their bar; movie and show pages over their backdrop.
                if (adding && route !in TOP_PAGES) PartyPill(tv = false, Modifier.align(Alignment.TopEnd).padding(top = 14.dp, end = 12.dp), onBackToParty)
                added?.let { (label, ids) ->
                    Snackbar(
                        "Added “$label” to Up next",
                        Modifier.align(Alignment.BottomCenter).padding(12.dp),
                        onUndo = {
                            ids.forEach { party?.send?.invoke(Protocol.queueRemove(it)) }
                            added = null
                        },
                    )
                }
            }
        }
    }

    if (askCode) {
        JoinCodeDialog(onDismiss = { askCode = false }) { code ->
            val id = Prefs.roomCode(code)
            if (id.isNotEmpty()) {
                askCode = false
                scope.launch { guard { api.room(id) }?.let { RoomActivity.start(context, it.id) } }
            }
        }
    }
    ending?.let { room ->
        val endIt = { save: Boolean ->
            ending = null
            scope.launch {
                guard { api.endRoom(room.id, prefs.name, save) }?.let {
                    rooms = rooms.filter { it.id != room.id }
                    if (started?.id == room.id) started = null
                    if (save) guard { api.spots() }?.let { spots = it }
                }
            }
        }
        // Partway through something, the choice is whether to save the spot; otherwise just a check.
        val p = room.playback
        val position = p?.let { it.position + if (it.paused) 0.0 else sinceFetch / 1000.0 } ?: 0.0
        val duration = p?.duration ?: room.media?.duration
        val upcoming = room.upNext?.count ?: 0
        if (room.media != null && worthSaving(position, duration, upcoming, room.media.marks?.credits)) {
            SaveSpotDialog(
                api,
                spotPreview(room.media, position, duration, room.upNext?.item, upcoming),
                onSave = { endIt(true) },
                onDontSave = { endIt(false) },
                onCancel = { ending = null },
            )
        } else AlertDialog(
            onDismissRequest = { ending = null },
            title = { Text("End this party?") },
            text = { Text("${room.media?.title ?: "This party"} ends for everyone. Anyone watching goes back to the start screen.") },
            confirmButton = { DialogButton("End party", danger = true) { endIt(false) } },
            dismissButton = { DialogButton("Cancel") { ending = null } },
            containerColor = DialogSurface,
        )
    }
    spotOptions?.let { s ->
        SpotOptions(api, s, if (alone) "Play from here" else "Start party here", onStart = { spotActions.start(s) }, onOpen = { spotActions.open(s) }, onRemove = { spotActions.remove(s) }, onClose = { spotOptions = null })
    }
    val lib = library
    val shownMedia = shownInfo?.let { id -> lib?.byId?.get(id) }
    if (lib != null && shownMedia != null) {
        val media: MediaItem = shownMedia
        val show = media.episode?.let { lib.shows.firstOrNull { s -> media in s.episodes } }
        DetailsDialog(
            api = api,
            media = media,
            length = listOfNotNull(media.extra?.kind, media.duration?.let(::clock), "Subtitles".takeIf { media.subtitles.isNotEmpty() }).joinToString(" · "),
            credit = lib.details,
            onStart = { shownInfo = null; actions.start(media, media.part?.ids) },
            onBingeFrom = show?.takeIf { !adding }?.let { s -> { shownInfo = null; actions.start(media, s.episodes.drop(s.episodes.indexOf(media)).map { it.id }) } },
            onClose = { shownInfo = null },
            startLabel = actions.startLabel,
            onQueue = if (!adding) null else ({ shownInfo = null; actions.queue(media.part?.ids ?: listOf(media.id), media.meta?.title ?: media.title) }),
            queued = adding && PartyLink.queued(media.id),
        )
    }
}

/** What Home's "Pick up where you left off" cards do. [options] is a TV's OK. */
private class SpotActions(val start: (Spot) -> Unit, val open: (Spot) -> Unit, val remove: (Spot) -> Unit, val options: (Spot) -> Unit)

private val TOP_PAGES = setOf("home", "movies", "shows", "parties", "search", "settings")

// ---------- Shells: the phone's bottom bar and the TV's side menu ----------

private data class NavItem(val route: Route, val label: String, val icon: Int)

private val NAV = listOf(
    NavItem("home", "Home", R.drawable.ic_nav_home),
    NavItem("movies", "Movies", R.drawable.ic_nav_movies),
    NavItem("shows", "TV Shows", R.drawable.ic_nav_shows),
    NavItem("parties", "Parties", R.drawable.ic_nav_parties),
)

/** Which menu item a page belongs to: a movie's page sits under Movies, a show's under TV shows. */
private fun section(route: Route) = when {
    route.startsWith("movie/") -> "movies"
    route.startsWith("show/") -> "shows"
    else -> route
}

@Composable
private fun PhoneShell(route: Route, adding: Boolean, alone: Boolean, setAlone: (Boolean) -> Unit, onCode: () -> Unit, onRefresh: () -> Unit, onSettings: () -> Unit, onBack: () -> Unit, go: (Route) -> Unit, content: @Composable () -> Unit) {
    val context = LocalContext.current
    Column(Modifier.fillMaxSize()) {
        // Movie and show pages draw their own header over the backdrop.
        if (route in TOP_PAGES && adding) {
            // Adding to a party: back to it, search, and which party.
            Row(Modifier.fillMaxWidth().height(60.dp).padding(start = 4.dp, end = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                IconAction(R.drawable.ic_back, "Back to the party", onBack)
                IconAction(R.drawable.ic_search, "Search") { go("search") }
                Spacer(Modifier.weight(1f))
                PartyPill(tv = false, Modifier, onBack)
            }
        } else if (route in TOP_PAGES) {
            Row(Modifier.fillMaxWidth().height(60.dp).padding(start = 16.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    LogoMark(30.dp)
                    Column {
                        Text("Popcorn Club", fontFamily = BarlowCondensed, fontWeight = FontWeight.Bold, fontSize = 24.sp, lineHeight = 24.sp, color = Color.White)
                        // A quiet but plain sign that Play is just for you (see ui-redesign/phone-top-bar).
                        if (alone) Text("Watching alone", color = Accent, fontSize = 12.sp, lineHeight = 14.sp, fontWeight = FontWeight.SemiBold)
                    }
                }
                IconAction(R.drawable.ic_search, "Search") { go("search") }
                var menu by remember { mutableStateOf(false) }
                Box {
                    IconAction(R.drawable.ic_more_vert, "More") { menu = true }
                    DropdownMenu(expanded = menu, onDismissRequest = { menu = false }, containerColor = Panel) {
                        // Together / Alone lives here (Jake: the top bar was too crowded); the menu stays open so the switch is seen to flip.
                        DropdownMenuItem(
                            text = { Text("Watch alone") },
                            leadingIcon = { Icon(painterResource(R.drawable.ic_user), null) },
                            trailingIcon = {
                                Switch(
                                    checked = alone,
                                    onCheckedChange = null,
                                    colors = SwitchDefaults.colors(checkedTrackColor = Accent, checkedThumbColor = Color(0xFF1C1520), checkedBorderColor = Accent),
                                )
                            },
                            onClick = { setAlone(!alone) },
                        )
                        HorizontalDivider(color = Muted.copy(alpha = 0.2f))
                        DropdownMenuItem(text = { Text("Join with code") }, leadingIcon = { Icon(painterResource(R.drawable.ic_keypad), null) }, onClick = { menu = false; onCode() })
                        DropdownMenuItem(text = { Text("Scan TV code") }, leadingIcon = { Icon(painterResource(R.drawable.ic_scan), null) }, onClick = {
                            menu = false
                            (context as? MainActivity)?.scanCode()
                        })
                        DropdownMenuItem(text = { Text("Refresh library") }, leadingIcon = { Icon(painterResource(R.drawable.ic_refresh), null) }, onClick = { menu = false; onRefresh() })
                        DropdownMenuItem(text = { Text("Settings") }, leadingIcon = { Icon(painterResource(R.drawable.ic_gear), null) }, onClick = { menu = false; onSettings() })
                    }
                }
            }
        }
        Box(Modifier.weight(1f).fillMaxWidth()) { content() }
        NavigationBar(containerColor = Color(0xFF211A2A)) {
            NAV.filter { !adding || it.route != "parties" }.forEach { item ->
                NavigationBarItem(
                    selected = section(route) == item.route,
                    onClick = { go(item.route) },
                    icon = { Icon(painterResource(item.icon), contentDescription = null) },
                    label = { Text(item.label, fontSize = 12.sp) },
                    colors = NavigationBarItemDefaults.colors(
                        selectedIconColor = Color(0xFFF3C49F),
                        selectedTextColor = Color.White,
                        indicatorColor = Accent.copy(alpha = 0.24f),
                        unselectedIconColor = Muted,
                        unselectedTextColor = Muted,
                    ),
                )
            }
        }
    }
}

@Composable
private fun IconAction(icon: Int, label: String, onClick: () -> Unit) {
    Box(Modifier.size(48.dp).clip(CircleShape).clickable(onClick = onClick), contentAlignment = Alignment.Center) {
        Icon(painterResource(icon), contentDescription = label, tint = Color.White, modifier = Modifier.size(22.dp))
    }
}

/** The card the remote was last on in the TV's page, so leaving the menu goes back to it. */
internal class FocusMemory {
    var last: FocusRequester? = null
}

internal val LocalFocusMemory = staticCompositionLocalOf<FocusMemory?> { null }

/** Inside the TV's page, notes this card as the last one the remote was on (see TvShell). Elsewhere it does nothing. */
internal fun Modifier.remembersFocus(): Modifier = composed {
    val memory = LocalFocusMemory.current ?: return@composed this
    val requester = remember { FocusRequester() }
    DisposableEffect(memory) { onDispose { if (memory.last === requester) memory.last = null } }
    focusRequester(requester).onFocusChanged { if (it.isFocused) memory.last = requester }
}

/** The TV: a column of icons on the left that widens with labels while the remote is on it, over the page. */
@OptIn(ExperimentalComposeUiApi::class)
@Composable
internal fun TvShell(route: Route, adding: Boolean, alone: Boolean, setAlone: (Boolean) -> Unit, onCode: () -> Unit, onRefresh: () -> Unit, onSettings: () -> Unit, go: (Route) -> Unit, content: @Composable () -> Unit) {
    var open by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val width by animateDpAsState(if (open) 260.dp else 76.dp, label = "menu")
    // The page reaches under the menu (its backdrop shows through), so to the remote's Right search it starts left of
    // the menu and never counts as "to the right": the menu sends Right to the page itself.
    // (No focusRestorer: on Compose 1.7 it crashes lazy rows with "Release should only be called once".)
    val page = remember { FocusRequester() }
    // Left from the page lands on the menu item of the page you're on, not whichever item is level with the card.
    val current = remember { FocusRequester() }
    val here = section(route)
    val hasItem = here == "search" || here == "home" || here == "movies" || here == "shows" || (here == "parties" && !adding) || (here == "settings" && !adding)
    // Back in the menu just closes it, back to the page (registered after the dashboard's Back, so it goes first).
    // Right or Back from the menu: to the card the remote left the page from, or the page's first if it has gone.
    val memory = remember { FocusMemory() }
    val backToPage = {
        scope.launch {
            val card = memory.last
            if (card == null || runCatching { card.requestFocus() }.isFailure) runCatching { page.requestFocus() }
        }
        Unit
    }
    BackHandler(enabled = open) { backToPage() }
    // Coming back from the player lands on the page, not the menu. The card that started the party may have gone
    // while you watched (a party that ended, a spot that was used), and with nothing focused Android hands focus to
    // the top-left of the screen: the menu's Search.
    @Suppress("DEPRECATION")
    val lifecycle = androidx.compose.ui.platform.LocalLifecycleOwner.current.lifecycle
    DisposableEffect(lifecycle) {
        // Only after being covered: adding the observer replays ON_RESUME right away.
        var away = false
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_STOP) away = true
            if (event == Lifecycle.Event.ON_RESUME && away) scope.launch {
                away = false
                // After the window has its focus back.
                withFrameNanos {}
                delay(150)
                if (open) backToPage()
            }
        }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer) }
    }
    Box(Modifier.fillMaxSize()) {
        @OptIn(ExperimentalComposeUiApi::class)
        Box(
            Modifier
                .fillMaxSize()
                .focusRequester(page)
                // Up or Down past the top or bottom of a page stays on the page instead of jumping into the menu;
                // Left still opens it.
                .focusProperties {
                    exit = { direction ->
                        if (direction == FocusDirection.Up || direction == FocusDirection.Down) FocusRequester.Cancel
                        else FocusRequester.Default
                    }
                }
                .focusGroup(),
        ) { CompositionLocalProvider(LocalFocusMemory provides memory) { content() } }
        Column(
            Modifier
                .fillMaxHeight()
                .width(width)
                .background(
                    if (open) Brush.horizontalGradient(listOf(Color(0xFA100C15), Color(0xEB100C15)))
                    else Brush.horizontalGradient(listOf(Color(0xD9100C15), Color.Transparent)),
                )
                .onFocusChanged { open = it.hasFocus }
                .focusProperties { enter = { if (hasItem) current else FocusRequester.Default } }
                .focusGroup()
                // The remote's Right goes back to the card it left (see backToPage); each item's right = page is the
                // fallback for focus moves that don't come from a key.
                .onPreviewKeyEvent {
                    if (it.type == KeyEventType.KeyDown && it.key == Key.DirectionRight) {
                        backToPage()
                        true
                    } else false
                }
                // Folded, the rows are 48dp wide, so their 20dp icons (14dp in) sit in the middle.
                .padding(horizontal = 14.dp, vertical = 24.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Row(Modifier.padding(start = 11.dp, bottom = 18.dp), verticalAlignment = Alignment.CenterVertically) {
                if (open) LogoTitle(fontSize = 20.sp, markSize = 26.dp) else LogoMark(26.dp)
            }
            TvMenuItem(R.drawable.ic_search, "Search", here == "search", open, page, current) { go("search") }
            // While adding to a party there's no other party to go to, and no signing out from under it.
            listOfNotNull(
                NavItem("home", "Home", R.drawable.ic_nav_home),
                NavItem("movies", "Movies", R.drawable.ic_nav_movies),
                NavItem("shows", "TV Shows", R.drawable.ic_nav_shows),
                NavItem("parties", "Watch Parties", R.drawable.ic_nav_parties).takeIf { !adding },
            ).forEach { item -> TvMenuItem(item.icon, item.label, here == item.route, open, page, current) { go(item.route) } }
            if (!adding) TvMenuItem(R.drawable.ic_keypad, "Join with code", false, open, page, current, onCode)
            Spacer(Modifier.weight(1f))
            TvMenuItem(R.drawable.ic_refresh, "Refresh library", false, open, page, current, onRefresh)
            if (!adding) TvMenuItem(R.drawable.ic_gear, "Settings", here == "settings", open, page, current, onSettings)
            if (!adding) TvModeItem(alone, open, page) { setAlone(!alone) }
        }
    }
}

@Composable
private fun TvMenuItem(icon: Int, label: String, selected: Boolean, open: Boolean, page: FocusRequester, current: FocusRequester, onClick: () -> Unit) {
    val interaction = remember { MutableInteractionSource() }
    val focused by interaction.collectIsFocusedAsState()
    Row(
        Modifier
            .fillMaxWidth()
            .height(40.dp)
            .clip(RoundedCornerShape(20.dp))
            .background(if (focused) FocusFill else if (selected) Tonal else Color.Transparent)
            .then(if (selected) Modifier.focusRequester(current) else Modifier)
            .focusProperties { right = page }
            .remembersFocus()
            .clickable(interactionSource = interaction, indication = null, onClick = onClick)
            .padding(horizontal = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Icon(painterResource(icon), contentDescription = label, tint = if (focused) OnFocus else if (selected) Color.White else Muted, modifier = Modifier.size(20.dp))
        if (open) Text(label, color = if (focused) OnFocus else Color.White, fontSize = 15.sp, fontWeight = FontWeight.SemiBold, maxLines = 1)
    }
}

/**
 * The TV's Watch alone switch, last in the menu: a row like the others with a switch at its end, orange while on
 * (like the phone's ⋮ menu). Folded, its icon turns orange. OK flips it.
 */
@Composable
private fun TvModeItem(alone: Boolean, open: Boolean, page: FocusRequester, onClick: () -> Unit) {
    val interaction = remember { MutableInteractionSource() }
    val focused by interaction.collectIsFocusedAsState()
    Row(
        Modifier
            .fillMaxWidth()
            .height(40.dp)
            .clip(RoundedCornerShape(20.dp))
            .background(if (focused) FocusFill else Color.Transparent)
            .focusProperties { right = page }
            .remembersFocus()
            .clickable(interactionSource = interaction, indication = null, onClick = onClick)
            .semantics { stateDescription = if (alone) "On" else "Off" }
            .padding(start = 14.dp, end = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Icon(
            painterResource(R.drawable.ic_user),
            contentDescription = "Watch alone",
            tint = if (focused) OnFocus else if (alone) Accent else Muted,
            modifier = Modifier.size(20.dp),
        )
        if (open) {
            Text("Watch alone", color = if (focused) OnFocus else Color.White, fontSize = 15.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, modifier = Modifier.weight(1f))
            ModeSwitch(alone)
        }
    }
}

/** A drawn switch (the row takes the remote's focus, not the switch): orange with a dark knob on the right when on. */
@Composable
private fun ModeSwitch(on: Boolean) {
    val off = Color(0xFF6F667C)
    Box(
        Modifier
            .size(width = 40.dp, height = 24.dp)
            .clip(CircleShape)
            .then(if (on) Modifier.background(Accent) else Modifier.border(2.dp, off, CircleShape))
            .padding(horizontal = 4.dp),
        contentAlignment = if (on) Alignment.CenterEnd else Alignment.CenterStart,
    ) {
        Box(Modifier.size(if (on) 16.dp else 12.dp).clip(CircleShape).background(if (on) Color(0xFF2A1A10) else off))
    }
}

// ---------- Settings ----------

/** Your name, the server, and Sign out (which asks first), instead of the menu's Settings signing you out. */
@Composable
private fun SettingsPage(prefs: Prefs, tv: Boolean, onSignOut: () -> Unit) {
    var name by remember { mutableStateOf(prefs.name) }
    var editing by remember { mutableStateOf(false) }
    var confirming by remember { mutableStateOf(false) }
    val first = remember { FocusRequester() }
    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(start = if (tv) 128.dp else 16.dp, end = if (tv) 48.dp else 16.dp, top = if (tv) 40.dp else 8.dp, bottom = 32.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        PageTitle("Settings", null)
        Spacer(Modifier.height(4.dp))
        SettingsRow(R.drawable.ic_user, "Your name", name, Modifier.focusRequester(first)) { editing = true }
        SettingsRow(R.drawable.ic_tv, "Server", prefs.serverUrl.substringAfter("://"), Modifier, onClick = null)
        SettingsRow(R.drawable.ic_leave, "Sign out", if (tv) "Sign in again later with your phone or the password" else "Sign in again later with the password", Modifier) { confirming = true }
    }
    if (tv) LaunchedEffect(Unit) { runCatching { first.requestFocus() } }

    if (editing) {
        var draft by remember { mutableStateOf(name) }
        val field = remember { FocusRequester() }
        val save = {
            val clean = draft.trim().take(32)
            if (clean.isNotEmpty()) {
                prefs.name = clean
                name = clean
                editing = false
            }
        }
        AlertDialog(
            onDismissRequest = { editing = false },
            title = { Text("Your name") },
            text = {
                OutlinedTextField(
                    value = draft,
                    onValueChange = { draft = it },
                    label = { Text("Shown to everyone in a party") },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                    keyboardActions = KeyboardActions(onDone = { save() }),
                    modifier = Modifier.focusRequester(field),
                )
            },
            confirmButton = { DialogButton("Save") { save() } },
            dismissButton = { DialogButton("Cancel") { editing = false } },
            containerColor = DialogSurface,
        )
        LaunchedEffect(Unit) { runCatching { field.requestFocus() } }
    }
    if (confirming) {
        AlertDialog(
            onDismissRequest = { confirming = false },
            title = { Text("Sign out?") },
            text = { Text(if (tv) "This TV goes back to the start screen. To sign in again, choose Sign in with your phone, or enter the password." else "This phone goes back to the start screen. To sign in again, enter the password.") },
            confirmButton = { DialogButton("Sign out", danger = true) { confirming = false; onSignOut() } },
            dismissButton = { DialogButton("Cancel") { confirming = false } },
            containerColor = DialogSurface,
        )
    }
}

/** A settings row: icon, label and value; white while the remote is on it. [onClick] null: information only. */
@Composable
private fun SettingsRow(icon: Int, label: String, value: String, modifier: Modifier, onClick: (() -> Unit)?) {
    val interaction = remember { MutableInteractionSource() }
    val focused by interaction.collectIsFocusedAsState()
    Row(
        modifier
            .widthIn(max = 640.dp)
            .fillMaxWidth()
            .clip(RoundedCornerShape(16.dp))
            .background(if (focused) FocusFill else Panel)
            .remembersFocus()
            .then(if (onClick != null) Modifier.clickable(interactionSource = interaction, indication = null, onClick = onClick) else Modifier)
            .padding(horizontal = 18.dp, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Icon(painterResource(icon), contentDescription = null, tint = if (focused) OnFocus else Muted, modifier = Modifier.size(22.dp))
        Column(Modifier.weight(1f)) {
            Text(label, color = if (focused) OnFocus else Color.White, fontSize = 16.sp, lineHeight = 20.sp, fontWeight = FontWeight.SemiBold)
            Text(value, color = if (focused) OnFocusMuted else Muted, fontSize = 13.sp, lineHeight = 17.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

// ---------- Home ----------

@Composable
private fun HomePage(
    lib: Library,
    rooms: List<RoomSummary>,
    spots: List<Spot>,
    sa: SpotActions,
    sinceFetch: Long,
    started: RoomSummary?,
    error: String?,
    a: Actions,
    state: LazyListState,
    onDismissStarted: () -> Unit,
    removedAt: Int? = null,
    onRefocused: () -> Unit = {},
) {
    val tv = a.tv
    val side = if (tv) 64.dp else 16.dp
    val firstFocus = remember { FocusRequester() }
    val spotFocus = remember { mutableMapOf<String, FocusRequester>() }
    // Removing a spot takes away the card the remote was on: go to the next one (or the one before), or the banner.
    if (tv && removedAt != null) LaunchedEffect(removedAt, spots) {
        // After the options dialog has closed and handed the window back.
        withFrameNanos { }
        delay(150)
        val next = spots.getOrNull(minOf(removedAt, spots.lastIndex))
        runCatching { (next?.let { spotFocus[it.id] } ?: firstFocus).requestFocus() }
        onRefocused()
    }
    Box(Modifier.fillMaxSize()) {
        // On a TV the newest title's backdrop fills the top of the screen behind the banner, fading as you scroll.
        var shown by remember { mutableStateOf(0) }
        if (tv) {
            val alpha by animateFloatAsState(if (state.firstVisibleItemIndex == 0) 1f else 0f, label = "backdrop")
            lib.featured.getOrNull(shown)?.let { BackdropBehind(a.api, it.backdrop, Modifier.graphicsLayer { this.alpha = alpha }) }
        }
        LazyColumn(state = state, contentPadding = PaddingValues(start = side + if (tv) 32.dp else 0.dp, end = side, bottom = 32.dp), verticalArrangement = Arrangement.spacedBy(if (tv) 28.dp else 22.dp)) {
            error?.let { item { Text(it, color = ErrorColor) } }
            started?.let { room -> item(key = "started") { StartedCard(room, a, onDismissStarted) } }
            if (lib.featured.isNotEmpty() && lib.details) {
                item(key = "banner") {
                    if (tv) TvBanner(lib.featured, a, firstFocus) { shown = it } else PhoneBanner(lib.featured, a)
                }
            }
            // Under the banner, before Watch parties (see ui-redesign/resume).
            if (spots.isNotEmpty()) {
                item(key = "spots") {
                    ShelfRow("Pick up where you left off", null, a) {
                        items(spots, key = { it.id }) { s ->
                            if (tv) Box(Modifier.focusRequester(spotFocus.getOrPut(s.id) { FocusRequester() })) { TvSpotCard(a.api, lib.details, s, 260.dp) { sa.options(s) } }
                            else PhoneSpotCard(a.api, lib.details, s, 250.dp, onOpen = { sa.open(s) }, onStart = { sa.start(s) }, onRemove = { sa.remove(s) })
                        }
                    }
                }
            }
            if (rooms.isNotEmpty()) {
                item(key = "parties") {
                    ShelfRow("Watch Parties", null, a) {
                        items(rooms, key = { it.id }) { PartyCard(it, sinceFetch, lib.details, a, width = if (tv) 300.dp else 290.dp) }
                    }
                }
            }
            if (lib.recent.isNotEmpty()) {
                item(key = "recent") {
                    ShelfRow("Recently added", null, a) {
                        items(lib.recent, key = { if (it is MediaItem) it.id else (it as Show).name }) { x ->
                            if (x is MediaItem) MovieCard(x, lib, a) else ShowCard(x as Show, lib, a)
                        }
                    }
                }
            }
            if (lib.movies.isNotEmpty()) {
                item(key = "movies") {
                    ShelfRow("Movies", "movies", a) {
                        items(lib.movies.filter { it.extra == null }.sortedWith { x, y -> naturalCompare(x.title, y.title) }.take(24), key = { it.id }) { MovieCard(it, lib, a) }
                    }
                }
            }
            if (lib.shows.isNotEmpty()) {
                item(key = "shows") {
                    ShelfRow("TV Shows", "shows", a) { items(lib.shows.take(24), key = { it.name }) { ShowCard(it, lib, a) } }
                }
            }
            if (lib.details) item(key = "credit") { Text(TMDB_CREDIT, color = Muted, fontSize = 12.sp) }
        }
    }
    // A TV remote starts on the banner's Start party.
    if (tv) LaunchedEffect(Unit) { runCatching { firstFocus.requestFocus() } }
}

/** The page's backdrop across the top of the screen, fading into the page at the bottom and left. */
@Composable
private fun BackdropBehind(api: Api, path: String, modifier: Modifier = Modifier, height: Float = 0.78f) {
    val image = rememberImage(api, path, "w1280")
    Box(modifier.fillMaxWidth().fillMaxHeight(height)) {
        image?.let { Image(it, null, contentScale = ContentScale.Crop, alignment = Alignment.TopCenter, modifier = Modifier.fillMaxSize()) }
        Box(Modifier.fillMaxSize().background(Brush.horizontalGradient(0f to Bg, 0.3f to Bg.copy(alpha = 0.9f), 0.65f to Bg.copy(alpha = 0.3f), 0.85f to Color.Transparent)))
        Box(Modifier.fillMaxSize().background(Brush.verticalGradient(0.45f to Color.Transparent, 1f to Bg)))
    }
}

@Composable
private fun TvBanner(featured: List<Featured>, a: Actions, firstFocus: FocusRequester, onShown: (Int) -> Unit) {
    var index by remember { mutableStateOf(0) }
    var holding by remember { mutableStateOf(false) }
    // Takes turns every 8 seconds, except while the remote is on its buttons.
    LaunchedEffect(index, holding, featured.size) {
        if (holding || featured.size < 2) return@LaunchedEffect
        delay(8000)
        index = (index + 1) % featured.size
    }
    LaunchedEffect(index) { onShown(index) }
    val f = featured[index.coerceAtMost(featured.lastIndex)]
    Column(Modifier.padding(top = 56.dp).heightIn(min = 270.dp).width(560.dp).onFocusChanged { holding = it.hasFocus }) {
        Eyebrow("New in your library")
        Text(f.title, fontFamily = BarlowCondensed, fontWeight = FontWeight.Bold, fontSize = 48.sp, lineHeight = 50.sp, color = Color.White, maxLines = 2, overflow = TextOverflow.Ellipsis)
        Text(f.facts, color = Color.White.copy(alpha = 0.85f), fontSize = 14.sp, modifier = Modifier.padding(top = 6.dp))
        val overview = f.movie?.meta?.overview
        overview?.let { Text(it, color = Color.White.copy(alpha = 0.8f), fontSize = 14.sp, maxLines = 3, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 10.dp)) }
        Row(Modifier.padding(top = 20.dp), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
            val movie = f.movie
            if (movie != null) Pill(a.startLabel, R.drawable.ic_play_filled, primary = true, modifier = Modifier.focusRequester(firstFocus)) { a.start(movie, movie.part?.ids) }
            Pill(if (movie != null) "Details" else "Episodes", R.drawable.ic_info, modifier = if (movie == null) Modifier.focusRequester(firstFocus) else Modifier) { a.go(f.route) }
            if (featured.size > 1) Dots(featured.size, index)
        }
    }
}

@Composable
private fun PhoneBanner(featured: List<Featured>, a: Actions) {
    val pager = rememberPagerState { featured.size }
    LaunchedEffect(pager.currentPage, pager.isScrollInProgress) {
        if (featured.size < 2 || pager.isScrollInProgress) return@LaunchedEffect
        delay(8000)
        pager.animateScrollToPage((pager.currentPage + 1) % featured.size)
    }
    Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(10.dp)) {
        HorizontalPager(pager, pageSpacing = 12.dp) { i ->
            val f = featured[i]
            Box(Modifier.fillMaxWidth().height(220.dp).clip(RoundedCornerShape(24.dp)).background(Panel).clickable { a.go(f.route) }) {
                Art(a.api, f.backdrop, "w780", Modifier.fillMaxSize())
                Box(Modifier.fillMaxSize().background(Brush.verticalGradient(0.3f to Color.Transparent, 1f to Color(0xF2100C15))))
                Column(Modifier.align(Alignment.BottomStart).padding(18.dp)) {
                    Eyebrow("New in your library", small = true)
                    Text(f.title, fontFamily = BarlowCondensed, fontWeight = FontWeight.Bold, fontSize = 30.sp, lineHeight = 32.sp, color = Color.White, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    Text(f.facts.split(" · ").take(3).joinToString(" · "), color = Color.White.copy(alpha = 0.85f), fontSize = 13.sp)
                    Row(Modifier.padding(top = 10.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        val movie = f.movie
                        if (movie != null) Pill(a.startLabel, R.drawable.ic_play_filled, primary = true, small = true) { a.start(movie, movie.part?.ids) }
                        Pill(if (movie != null) "Details" else "Episodes", null, small = true) { a.go(f.route) }
                    }
                }
            }
        }
        if (featured.size > 1) Dots(featured.size, pager.currentPage, small = true)
    }
}

@Composable
private fun Eyebrow(text: String, small: Boolean = false) {
    Text(text.uppercase(), color = Accent, fontSize = if (small) 11.sp else 12.sp, fontWeight = FontWeight.Bold, letterSpacing = 1.6.sp, modifier = Modifier.padding(bottom = 4.dp))
}

@Composable
private fun Dots(count: Int, current: Int, small: Boolean = false) {
    Row(Modifier.padding(start = if (small) 0.dp else 12.dp), horizontalArrangement = Arrangement.spacedBy(5.dp)) {
        repeat(count) { i ->
            Box(Modifier.width(if (i == current) 18.dp else 6.dp).height(6.dp).clip(CircleShape).background(if (i == current) Accent else Color.White.copy(alpha = 0.3f)))
        }
    }
}

/** "Party ready" after Start party: the code, Join party and End party. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun StartedCard(room: RoomSummary, a: Actions, onDismiss: () -> Unit) {
    Column(
        Modifier
            .padding(top = if (a.tv) 40.dp else 0.dp)
            .fillMaxWidth()
            .clip(RoundedCornerShape(16.dp))
            .background(Panel)
            .border(1.dp, Accent.copy(alpha = 0.35f), RoundedCornerShape(16.dp))
            .padding(18.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(
            "Party ready for ${room.media?.title ?: "your movie"}" +
                (room.binge?.let { ", the first of ${it.length} in this binge" } ?: "") +
                ". Share the code, then join when you're ready to watch.",
            color = Muted,
        )
        Text(room.id.uppercase(), fontSize = 36.sp, fontWeight = FontWeight.Bold, color = Color.White, letterSpacing = 4.sp)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Pill("Join party", null, primary = true, small = true) { a.join(room) }
            Pill("End party", null, small = true) { a.end(room) }
            Pill("Dismiss", null, small = true, text = true, onClick = onDismiss)
        }
    }
}

/** A titled sideways row of cards, with See all when it has a page of its own. */
@Composable
private fun ShelfRow(title: String, seeAll: Route?, a: Actions, content: LazyListScope.() -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(title, fontFamily = BarlowCondensed, fontWeight = FontWeight.Bold, fontSize = if (a.tv) 24.sp else 22.sp, color = Color.White, modifier = Modifier.weight(1f))
            // On a TV, See all is the menu item; on a phone it's a tap here.
            if (seeAll != null && !a.tv) Text("See all", color = Muted, fontSize = 13.sp, modifier = Modifier.clip(RoundedCornerShape(8.dp)).clickable { a.go(seeAll) }.padding(8.dp))
        }
        // Room for a focused card to grow without its white edge being clipped: the row reaches 12dp further out on the
        // left, and its padding brings the first card back in line with the title.
        val grow = if (a.tv) 12.dp else 0.dp
        LazyRow(
            modifier = Modifier.offset(x = -grow),
            horizontalArrangement = Arrangement.spacedBy(if (a.tv) 18.dp else 12.dp),
            contentPadding = PaddingValues(start = grow, end = grow, top = if (a.tv) 10.dp else 0.dp, bottom = if (a.tv) 10.dp else 0.dp),
            content = content,
        )
    }
}

// ---------- Cards ----------

/** A 2:3 poster with the title under it; the remote's card grows and gets a white edge. */
@Composable
private fun PosterCard(api: Api, details: Boolean, tv: Boolean, title: String, sub: String?, poster: String?, badge: String?, width: Dp?, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val interaction = remember { MutableInteractionSource() }
    val focused by interaction.collectIsFocusedAsState()
    val shape = RoundedCornerShape(if (tv) 10.dp else 12.dp)
    Column(modifier.then(if (width != null) Modifier.width(width) else Modifier.fillMaxWidth())) {
        Box(
            Modifier
                .fillMaxWidth()
                .aspectRatio(2f / 3f)
                .scale(if (focused) 1.07f else 1f)
                .border(if (focused) 3.dp else 0.dp, if (focused) Color.White else Color.Transparent, shape)
                .clip(shape)
                .background(Brush.linearGradient(listOf(Color(0xFF3A2F4A), Color(0xFF211A2A))))
                .remembersFocus()
                .clickable(interactionSource = interaction, indication = if (tv) null else androidx.compose.material3.ripple(), onClick = onClick),
        ) {
            val art = if (details && poster != null) rememberImage(api, poster, "w342") else null
            if (art != null) Image(art, null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
            else Text(title, fontFamily = BarlowCondensed, fontWeight = FontWeight.Bold, fontSize = 18.sp, lineHeight = 19.sp, color = Color.White, modifier = Modifier.align(Alignment.BottomStart).padding(10.dp))
            badge?.let {
                Text(it, fontSize = 11.sp, fontWeight = FontWeight.SemiBold, color = Color.White, modifier = Modifier.align(Alignment.TopEnd).padding(6.dp).clip(CircleShape).background(Color(0xCC0A070E)).padding(horizontal = 8.dp, vertical = 2.dp))
            }
        }
        // The body style's 24sp lines left a wide gap between the title and the line under it on the TV.
        val tight = if (tv) 16.sp else TextUnit.Unspecified
        Text(title, color = Color.White, fontSize = 13.sp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis, lineHeight = tight, modifier = Modifier.padding(top = if (focused) 10.dp else 6.dp))
        sub?.let { Text(it, color = Muted, fontSize = 12.sp, maxLines = 1, lineHeight = tight, modifier = Modifier.padding(top = if (tv) 2.dp else 0.dp)) }
    }
}

@Composable
private fun MovieCard(m: MediaItem, lib: Library, a: Actions, width: Dp? = if (a.tv) 118.dp else 112.dp) {
    PosterCard(a.api, lib.details, a.tv, m.meta?.title ?: m.title, (m.meta?.year ?: m.year)?.toString(), m.meta?.posterPath, null, width, { a.go("movie/${m.id}") })
}

@Composable
private fun ShowCard(s: Show, lib: Library, a: Actions, width: Dp? = if (a.tv) 118.dp else 112.dp) {
    PosterCard(a.api, lib.details, a.tv, s.name, plural(s.episodes.size, "episode"), s.meta?.showPosterPath, s.badge, width, { a.go("show/${s.name}") })
}

/** A running party: its art with Watching/Paused and the code, then who's there and how far in. */
@Composable
private fun PartyCard(room: RoomSummary, sinceFetch: Long, details: Boolean, a: Actions, width: Dp?) {
    val interaction = remember { MutableInteractionSource() }
    val focused by interaction.collectIsFocusedAsState()
    val m = room.media?.meta
    val ep = room.media?.episode
    val title = (if (ep != null) m?.show ?: ep.show else m?.title ?: room.media?.title ?: "Nothing picked yet") +
        (ep?.let { " · ${episodeLabel(it.season, it.episode)}" } ?: "") + (room.binge?.let { " · ${it.index} of ${it.length}" } ?: "")
    val state = when {
        room.playback == null || room.members.isEmpty() -> "WAITING"
        room.playback.paused -> "PAUSED"
        else -> "● WATCHING"
    }
    val shape = RoundedCornerShape(16.dp)
    Column(
        (if (width != null) Modifier.width(width) else Modifier.fillMaxWidth())
            .scale(if (focused) 1.04f else 1f)
            .border(if (focused) 3.dp else 0.dp, if (focused) Color.White else Color.Transparent, shape)
            .clip(shape)
            .background(Panel)
            .remembersFocus()
            .clickable(interactionSource = interaction, indication = if (a.tv) null else androidx.compose.material3.ripple()) { a.join(room) },
    ) {
        Box(Modifier.fillMaxWidth().aspectRatio(2.6f).background(Brush.linearGradient(listOf(Color(0xFF3A3550), Color(0xFF1F1A29))))) {
            val art = if (details) m?.backdropPath ?: m?.stillPath else null
            if (art != null) Art(a.api, art, "w780", Modifier.fillMaxSize())
            Box(Modifier.fillMaxSize().background(Brush.verticalGradient(0.4f to Color.Transparent, 1f to Panel)))
            Text(
                state,
                fontSize = 10.sp,
                fontWeight = FontWeight.Bold,
                letterSpacing = 0.6.sp,
                color = if (state == "● WATCHING") OnFocus else Color.White,
                modifier = Modifier.padding(8.dp).clip(CircleShape).background(if (state == "● WATCHING") Accent else Color(0xBF0A070E)).padding(horizontal = 8.dp, vertical = 2.dp),
            )
            Text(
                room.id.uppercase(),
                fontSize = 12.sp,
                fontWeight = FontWeight.Bold,
                letterSpacing = 1.5.sp,
                color = Color.White,
                modifier = Modifier.align(Alignment.TopEnd).padding(7.dp).clip(RoundedCornerShape(6.dp)).background(Color(0xCC0A070E)).padding(horizontal = 8.dp, vertical = 2.dp),
            )
        }
        Column(Modifier.padding(start = 12.dp, end = 12.dp, bottom = 12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(title, color = if (focused) Color.White else Color.White, fontWeight = FontWeight.SemiBold, fontSize = 15.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                Text("Join", color = Accent, fontWeight = FontWeight.SemiBold, fontSize = 14.sp, modifier = Modifier.padding(start = 8.dp))
            }
            Text(if (room.members.isEmpty()) "Nobody here yet" else room.members.map { it.name }.distinct().joinToString(", "), color = Muted, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            room.playback?.let { p ->
                val position = (p.position + if (p.paused) 0.0 else sinceFetch / 1000.0).let { pos -> p.duration?.let { pos.coerceAtMost(it) } ?: pos }
                p.duration?.takeIf { it > 0 }?.let { d ->
                    Box(Modifier.padding(top = 8.dp).fillMaxWidth().height(4.dp).clip(CircleShape).background(Color.White.copy(alpha = 0.18f))) {
                        Box(Modifier.fillMaxWidth((position / d).toFloat().coerceIn(0f, 1f)).fillMaxHeight().background(if (p.paused) Muted else Accent))
                    }
                }
                Text(clock(position) + (p.duration?.let { " / " + clock(it) } ?: ""), color = Muted, fontSize = 11.sp, modifier = Modifier.padding(top = 4.dp))
            }
        }
    }
}

// ---------- Grids: Movies, TV shows, Watch parties, Search ----------

private enum class Sort(val label: String) { AZ("A–Z"), Recent("Recently added"), Length("Length"), Size("Size") }

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun PosterGrid(lib: Library, title: String, movies: List<MediaItem>, shows: List<Show>, a: Actions, state: LazyGridState, sortable: Boolean = false, header: (@Composable () -> Unit)? = null) {
    var sort by rememberSaveable { mutableStateOf(Sort.AZ) }
    var subsOnly by rememberSaveable { mutableStateOf(false) }
    val sortedShows = remember(shows, sort, subsOnly) {
        val list = shows.filter { show -> !subsOnly || show.episodes.any { it.subtitles.isNotEmpty() } }
        when (sort) {
            Sort.Recent -> list.sortedByDescending { it.addedAt }
            else -> list.sortedWith { x, y -> naturalCompare(x.name, y.name) }
        }
    }
    val sorted = remember(movies, sort, subsOnly) {
        val list = movies.filter { !subsOnly || it.subtitles.isNotEmpty() }
        when (sort) {
            Sort.AZ -> list.sortedWith { x, y -> naturalCompare(x.title, y.title) }
            Sort.Recent -> list.sortedByDescending { it.addedAt }
            Sort.Length -> list.sortedByDescending { it.duration ?: -1.0 }
            Sort.Size -> list.sortedByDescending { it.size }
        }
    }
    val side = if (a.tv) 96.dp else 16.dp
    LazyVerticalGrid(
        columns = GridCells.Adaptive(if (a.tv) 118.dp else 104.dp),
        state = state,
        contentPadding = PaddingValues(start = side, end = if (a.tv) 48.dp else 16.dp, top = if (a.tv) 32.dp else 4.dp, bottom = 32.dp),
        horizontalArrangement = Arrangement.spacedBy(if (a.tv) 22.dp else 12.dp),
        verticalArrangement = Arrangement.spacedBy(if (a.tv) 24.dp else 18.dp),
    ) {
        item(span = { GridItemSpan(maxLineSpan) }) {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                PageTitle(title, (sorted.size + sortedShows.size).toString())
                if (sortable) {
                                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        // TV Shows sorts by name or newest episode only (Jake chose that over Length and Size).
                        val sorts = if (movies.isEmpty()) listOf(Sort.AZ, Sort.Recent) else Sort.entries
                        sorts.forEach { s -> Chip(s.label, sort == s, a.tv) { sort = s } }
                        Chip("Has subtitles", subsOnly, a.tv) { subsOnly = !subsOnly }
                    }
                }
                header?.invoke()
                if (sorted.isEmpty() && sortedShows.isEmpty()) Text(if (subsOnly) "Nothing has subtitles yet." else "Nothing here yet.", color = Muted)
            }
        }
        items(sorted, key = { it.id }) { MovieCard(it, lib, a, width = null) }
        items(sortedShows, key = { "show-" + it.name }) { ShowCard(it, lib, a, width = null) }
        if (lib.details) item(span = { GridItemSpan(maxLineSpan) }) { Text(TMDB_CREDIT, color = Muted, fontSize = 12.sp, modifier = Modifier.padding(top = 16.dp)) }
    }
}

@Composable
private fun PageTitle(title: String, count: String?) {
    Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        // The body style's 24sp lines are shorter than 32sp letters, which cut off their tops.
        Text(title, fontFamily = BarlowCondensed, fontWeight = FontWeight.Bold, fontSize = 32.sp, lineHeight = 38.sp, color = Color.White)
        count?.let { Text(it, color = Muted, fontSize = 16.sp, modifier = Modifier.padding(bottom = 5.dp)) }
    }
}

@Composable
private fun PartiesPage(rooms: List<RoomSummary>, sinceFetch: Long, details: Boolean, a: Actions, state: LazyGridState) {
    val side = if (a.tv) 96.dp else 16.dp
    LazyVerticalGrid(
        columns = GridCells.Adaptive(if (a.tv) 280.dp else 300.dp),
        state = state,
        contentPadding = PaddingValues(start = side, end = if (a.tv) 48.dp else 16.dp, top = if (a.tv) 32.dp else 4.dp, bottom = 32.dp),
        horizontalArrangement = Arrangement.spacedBy(18.dp),
        verticalArrangement = Arrangement.spacedBy(18.dp),
    ) {
        item(span = { GridItemSpan(maxLineSpan) }) { PageTitle("Watch Parties", rooms.size.toString()) }
        if (rooms.isEmpty()) item(span = { GridItemSpan(maxLineSpan) }) { Text("No parties right now. Start one from any movie or episode.", color = Muted) }
        items(rooms, key = { it.id }) { room ->
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                PartyCard(room, sinceFetch, details, a, width = null)
                Pill("End party", null, small = true, text = true) { a.end(room) }
            }
        }
    }
}

@Composable
private fun SearchPage(lib: Library, a: Actions, state: LazyGridState) {
    var query by rememberSaveable { mutableStateOf("") }
    val field = remember { FocusRequester() }
    val q = query.trim()
    val movies = if (q.isEmpty()) emptyList() else lib.movies.filter { matches(it, q) || it.meta?.title?.contains(q, ignoreCase = true) == true }
    val shows = if (q.isEmpty()) emptyList() else lib.shows.filter { s -> s.name.contains(q, ignoreCase = true) || s.aliases.any { it.contains(q, ignoreCase = true) } }
    PosterGrid(lib, if (q.isEmpty()) "Search" else "Results", movies, shows, a, state, header = {
        OutlinedTextField(
            value = query,
            onValueChange = { query = it },
            placeholder = { Text("Movies and TV Shows") },
            singleLine = true,
            leadingIcon = { Icon(painterResource(R.drawable.ic_search), null) },
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
            modifier = Modifier.fillMaxWidth().focusRequester(field),
        )
    })
    LaunchedEffect(Unit) { runCatching { field.requestFocus() } }
}

// ---------- Movie and show pages ----------

/** A movie's or show's page: backdrop, poster, title, facts, summary and buttons, then [below]. */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun DetailPage(
    lib: Library,
    a: Actions,
    state: LazyListState,
    title: String,
    facts: String,
    overview: String?,
    poster: String?,
    backdrop: String?,
    buttons: @Composable (FocusRequester) -> Unit,
    /** Over the buttons: a show's saved spot. */
    above: (@Composable () -> Unit)? = null,
    below: LazyListScope.() -> Unit,
) {
    val primary = remember { FocusRequester() }
    val tv = a.tv
    var headFocused by remember { mutableStateOf(false) }
    // On a TV, Compose scrolls whatever takes focus to 30% down the screen (its pivot), so focusing Binge, which sits
    // lower than that, scrolled the page down, and the effect below then snapped it back up: the page bounced each time
    // the remote came back to the buttons (from the menu, or as the page opened). The header asks to be shown whole
    // instead of just the button, which on a TV means scrolled to the top, so the page doesn't move when it's already there.
    var headSize by remember { mutableStateOf(IntSize.Zero) }
    val wholeHead = remember {
        object : BringIntoViewResponder {
            override fun calculateRectForParent(localRect: Rect): Rect = Rect(Offset.Zero, headSize.toSize())
            override suspend fun bringChildIntoView(localRect: () -> Rect?) {}
        }
    }
    // While the remote is on the buttons, the whole header stays in view. Bring-into-view only reveals the button, so
    // coming back up from the episodes, or back to a page that was left scrolled down, cut the name off at the top.
    if (tv) LaunchedEffect(state) {
        snapshotFlow { headFocused && (state.firstVisibleItemIndex > 0 || state.firstVisibleItemScrollOffset > 0) }
            .collect { if (it) runCatching { state.scrollToItem(0) } }
    }
    Box(Modifier.fillMaxSize()) {
        if (lib.details && backdrop != null) {
            if (tv) BackdropBehind(a.api, backdrop, height = 0.9f)
        }
        LazyColumn(state = state, contentPadding = PaddingValues(bottom = 32.dp)) {
            item(key = "head") {
                if (tv) {
                    Column(
                        Modifier
                            .onFocusChanged { headFocused = it.hasFocus }
                            .onSizeChanged { headSize = it }
                            .bringIntoViewResponder(wholeHead)
                            .padding(start = 128.dp, end = 48.dp, top = 56.dp)
                            .width(560.dp),
                    ) {
                        Text(title, fontFamily = BarlowCondensed, fontWeight = FontWeight.Bold, fontSize = 52.sp, lineHeight = 54.sp, color = Color.White, maxLines = 2, overflow = TextOverflow.Ellipsis)
                        Text(facts, color = Color.White.copy(alpha = 0.85f), fontSize = 14.sp, modifier = Modifier.padding(top = 6.dp))
                        overview?.let { Text(it, color = Color.White.copy(alpha = 0.8f), fontSize = 14.sp, maxLines = 3, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 10.dp)) }
                        above?.let { Box(Modifier.padding(top = 16.dp)) { it() } }
                        Row(Modifier.padding(top = if (above != null) 14.dp else 20.dp), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) { buttons(primary) }
                    }
                } else {
                    PhoneHeader(lib, a, title, facts, overview, poster, backdrop) {
                        above?.let { Box(Modifier.padding(top = 14.dp)) { it() } }
                        Column(Modifier.padding(top = if (above != null) 12.dp else 14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) { buttons(primary) }
                    }
                }
            }
            below()
            if (lib.details) item(key = "credit") { Text(TMDB_CREDIT, color = Muted, fontSize = 12.sp, modifier = Modifier.padding(start = if (tv) 128.dp else 16.dp, end = 16.dp, top = 20.dp)) }
        }
        if (!tv) {
            // Back over the backdrop, like a collapsing app bar.
            Box(Modifier.padding(8.dp).size(44.dp).clip(CircleShape).background(Color(0x730A070E)).clickable { a.go("back") }, contentAlignment = Alignment.Center) {
                Icon(painterResource(R.drawable.ic_back), contentDescription = "Back", tint = Color.White, modifier = Modifier.size(22.dp))
            }
            // While on Alone, the same quiet orange "Watching alone" as Home's top bar, on the Back button's dark glass so it
            // reads over any backdrop; tap to switch back to together.
            if (a.alone && !a.adding) {
                Box(
                    Modifier
                        .align(Alignment.TopEnd)
                        .padding(top = 12.dp, end = 12.dp)
                        .height(36.dp)
                        .clip(CircleShape)
                        .background(Color(0x730A070E))
                        .clickable { a.setAlone(false) }
                        .padding(horizontal = 14.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Text("Watching alone", color = Accent, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                }
            }
        }
    }
    if (tv) LaunchedEffect(title) { runCatching { primary.requestFocus() } }
}

@Composable
private fun PhoneHeader(lib: Library, a: Actions, title: String, facts: String, overview: String?, poster: String?, backdrop: String?, buttons: @Composable ColumnScope.() -> Unit) {
    Box {
        Box(Modifier.fillMaxWidth().height(250.dp)) {
            if (lib.details && backdrop != null) Art(a.api, backdrop, "w780", Modifier.fillMaxSize())
            else Box(Modifier.fillMaxSize().background(Brush.radialGradient(listOf(Color(0x595A4B78), Color.Transparent))))
            Box(Modifier.fillMaxSize().background(Brush.verticalGradient(0.4f to Color.Transparent, 1f to Bg)))
        }
        Column(Modifier.padding(start = 16.dp, end = 16.dp, top = 150.dp)) {
            Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                if (lib.details && poster != null) Art(a.api, poster, "w342", Modifier.width(92.dp).aspectRatio(2f / 3f).clip(RoundedCornerShape(10.dp)))
                Column {
                    Text(title, fontFamily = BarlowCondensed, fontWeight = FontWeight.Bold, fontSize = 34.sp, lineHeight = 36.sp, color = Color.White)
                    Text(facts, color = Color.White.copy(alpha = 0.85f), fontSize = 13.sp)
                }
            }
            overview?.let { Text(it, color = Color.White.copy(alpha = 0.82f), fontSize = 14.sp, lineHeight = 20.sp, maxLines = 4, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 12.dp)) }
            buttons()
        }
    }
}

@Composable
private fun MoviePage(lib: Library, m: MediaItem, a: Actions, state: LazyListState) {
    val extras = lib.extras[m.id].orEmpty()
    DetailPage(
        lib, a, state,
        title = m.meta?.title ?: m.title,
        facts = lib.movieFacts(m),
        overview = m.meta?.overview,
        poster = m.meta?.posterPath,
        backdrop = m.meta?.backdropPath,
        buttons = { primary ->
            Pill(a.startLabel, R.drawable.ic_play_filled, primary = true, wide = !a.tv, modifier = Modifier.focusRequester(primary)) { a.start(m, m.part?.ids) }
            if (a.adding) {
                val queued = PartyLink.queued(m.id)
                Pill(if (queued) "In Up next" else "Add to Up next", if (queued) R.drawable.ic_check else R.drawable.ic_list_plus, wide = !a.tv, enabled = !queued) {
                    a.queue(m.part?.ids ?: listOf(m.id), m.meta?.title ?: m.title)
                }
            }
        },
    ) {
        if (extras.isNotEmpty()) {
            item(key = "extras-title") { SectionTitle("Extras", a) }
            if (a.tv) item(key = "extras") { TvCards(extras, lib, a) }
            else items(extras, key = { it.id }) { EpisodeRow(it, lib, a) }
        }
    }
}

@Composable
private fun ShowPage(lib: Library, show: Show, a: Actions, state: LazyListState) {
    val extras = extrasOfShow(show, lib.extras)
    // After the seasons: -2 is the Specials chip (season 0), -1 the Extras chip.
    val tabs = show.seasons + listOfNotNull((-2).takeIf { show.specials.isNotEmpty() }, (-1).takeIf { extras != null })
    var season by rememberSaveable(show.name) { mutableStateOf(tabs.first()) }
    val shown = season.takeIf { it in tabs } ?: tabs.first()
    val binge = shown
    // A season's list has the specials that aired during it, where they aired (ui-redesign/specials/).
    val inSeason = { n: Int -> if (n == -1) extras.orEmpty() else if (n == -2) show.specials else show.bySeason[n].orEmpty() }
    val bingeName = if (binge == -1) "extras" else if (binge == -2) "specials" else "season $binge"
    // A saved spot puts Continue binge first (ui-redesign/resume/*-show-continue).
    val spot = if (a.adding) null else a.spotOf(show)
    DetailPage(
        lib, a, state,
        title = show.name,
        facts = lib.showFacts(show),
        overview = show.meta?.showOverview,
        poster = show.meta?.showPosterPath,
        backdrop = show.meta?.backdropPath,
        buttons = { primary ->
            val bingeSeason = { inSeason(binge).let { eps -> a.start(eps.first(), eps.map { it.id }) } }
            val addSeason = { a.queue(inSeason(binge).map { it.id }, bingeName.replaceFirstChar { it.uppercase() }) }
            if (a.adding && !a.tv) {
                // Binge (which replaces Up next and plays now) and Add side by side, as in ui-redesign/queue/phone-add.
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Pill("Binge $bingeName", R.drawable.ic_play_filled, primary = true, modifier = Modifier.weight(1f), onClick = bingeSeason)
                    Pill("Add $bingeName", R.drawable.ic_list_plus, modifier = Modifier.weight(1f), onClick = addSeason)
                }
            } else if (a.adding) {
                Pill("Binge $bingeName", R.drawable.ic_play_filled, primary = true, modifier = Modifier.focusRequester(primary), onClick = bingeSeason)
                Pill("Add $bingeName to Up next", R.drawable.ic_list_plus, onClick = addSeason)
                if (show.seasons.size > 1) MoreButton(listOf("Binge all ${show.seasons.size} seasons" to { a.start(show.episodes.first(), show.episodes.map { it.id }) }))
            } else if (spot != null) {
                Pill("Continue binge", R.drawable.ic_play_filled, primary = true, wide = !a.tv, modifier = Modifier.focusRequester(primary)) { a.startSpot(spot) }
                Pill("Binge $bingeName", R.drawable.ic_play_filled, wide = !a.tv, onClick = bingeSeason)
            } else {
                Pill("Binge $bingeName", R.drawable.ic_play_filled, primary = true, wide = !a.tv, modifier = Modifier.focusRequester(primary), onClick = bingeSeason)
            }
            if (show.seasons.size > 1 && !a.adding) {
                // With Continue binge, a phone shows it as a text button so the three fit.
                Pill("Binge all ${show.seasons.size} seasons", R.drawable.ic_list_video, wide = !a.tv, text = spot != null && !a.tv) { a.start(show.episodes.first(), show.episodes.map { it.id }) }
            }
        },
        above = spot?.let { sp -> @Composable { SpotLine(a.api, lib.details, sp, a.tv) } },
    ) {
        if (tabs.size > 1) {
            item(key = "seasons") {
                LazyRow(
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    contentPadding = PaddingValues(start = if (a.tv) 128.dp else 16.dp, end = 16.dp, top = if (a.tv) 28.dp else 16.dp, bottom = 8.dp),
                ) {
                    items(tabs) { n -> Chip(if (n == -2) "Specials" else if (n == -1) "Extras" else "Season $n", n == shown, a.tv) { season = n } }
                }
            }
        }
        val list = if (shown == -1) extras.orEmpty() else inSeason(shown)
        if (a.tv) {
            // On a TV the episodes are a sideways row of stills, like Google TV.
            item(key = "episodes-$shown") { TvCards(list, lib, a, special = { shown != -2 && it.episode?.season == 0 }) }
        } else {
            items(list, key = { it.id }) { EpisodeRow(it, lib, a, special = shown != -2 && it.episode?.season == 0) }
        }
    }
}

/** A TV's episodes or extras: a sideways row of stills, like Google TV, starting clear of the side menu. */
@Composable
private fun TvCards(list: List<MediaItem>, lib: Library, a: Actions, special: (MediaItem) -> Boolean = { false }) {
    LazyRow(horizontalArrangement = Arrangement.spacedBy(18.dp), contentPadding = PaddingValues(start = 128.dp, end = 48.dp, top = 12.dp, bottom = 12.dp)) {
        items(list, key = { it.id }) { EpisodeCard(it, lib, a, special = special(it)) }
    }
}

@Composable
private fun SectionTitle(text: String, a: Actions) {
    Text(text, fontFamily = BarlowCondensed, fontWeight = FontWeight.Bold, fontSize = 22.sp, color = Color.White, modifier = Modifier.padding(start = if (a.tv) 128.dp else 16.dp, top = 24.dp, bottom = 8.dp))
}

private fun episodeTitle(m: MediaItem, special: Boolean = false) =
    m.episode?.let { if (special) it.title ?: "Special ${it.episode}" else "${it.episode}. ${it.title ?: "Episode ${it.episode}"}" } ?: m.title

/** The episode's title, with a "Special" tag in front when it's a special sitting in a season (where it aired). */
@Composable
private fun EpisodeTitle(m: MediaItem, special: Boolean, size: Int, modifier: Modifier = Modifier) {
    Row(modifier, verticalAlignment = Alignment.CenterVertically) {
        if (special) {
            Text(
                "Special", color = Color(0xFFF0B888), fontWeight = FontWeight.SemiBold, fontSize = (size - 3).sp,
                modifier = Modifier.padding(end = 6.dp).clip(RoundedCornerShape(5.dp)).background(Color(0x2EE09A62)).padding(horizontal = 6.dp, vertical = 1.dp),
            )
        }
        Text(episodeTitle(m, special), color = Color.White, fontWeight = FontWeight.SemiBold, fontSize = size.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}
private fun episodeLength(m: MediaItem) = m.duration?.let(::runtime) ?: ""

/** A TV episode: its still with the length, the title under it, and the summary while the remote is on it. */
@Composable
private fun EpisodeCard(m: MediaItem, lib: Library, a: Actions, special: Boolean = false) {
    val interaction = remember { MutableInteractionSource() }
    val focused by interaction.collectIsFocusedAsState()
    val shape = RoundedCornerShape(10.dp)
    Column(Modifier.width(200.dp)) {
        Box(
            Modifier
                .fillMaxWidth()
                .aspectRatio(16f / 9f)
                .scale(if (focused) 1.07f else 1f)
                .border(if (focused) 3.dp else 0.dp, if (focused) Color.White else Color.Transparent, shape)
                .clip(shape)
                .background(Brush.linearGradient(listOf(Color(0xFF3A3550), Color(0xFF1F1A29))))
                .remembersFocus()
                .clickable(interactionSource = interaction, indication = null) { a.info(m) },
        ) {
            val still = m.meta?.stillPath
            if (lib.details && still != null) Art(a.api, still, "w300", Modifier.fillMaxSize())
            else Text(m.episode?.let { "E${it.episode}" } ?: m.extra?.kind.orEmpty(), color = Muted, fontFamily = BarlowCondensed, fontWeight = FontWeight.Bold, fontSize = 20.sp, modifier = Modifier.align(Alignment.Center))
            if (m.duration != null) Text(episodeLength(m), fontSize = 11.sp, color = Color.White, modifier = Modifier.align(Alignment.BottomEnd).padding(6.dp).clip(RoundedCornerShape(4.dp)).background(Color(0xCC0A070E)).padding(horizontal = 6.dp))
        }
        // The card takes the same room focused or not (the title only drawn 4dp higher, the summary hidden), so the
        // page under it doesn't shift when the remote leaves the row, say for the menu.
        EpisodeTitle(m, special, 13, Modifier.padding(top = 12.dp).offset(y = if (focused) 0.dp else (-4).dp))
        (m.meta?.overview ?: m.extra?.kind)?.let {
            Text(
                it, color = Color.White.copy(alpha = 0.75f), fontSize = 12.sp, maxLines = 2, overflow = TextOverflow.Ellipsis,
                modifier = if (focused) Modifier else Modifier.alpha(0f).clearAndSetSemantics {},
            )
        }
    }
}

/** A phone episode or extra: still, title, summary, and a round play button that starts a party with it. */
@Composable
private fun EpisodeRow(m: MediaItem, lib: Library, a: Actions, special: Boolean = false) {
    Row(
        Modifier.fillMaxWidth().clickable { a.info(m) }.padding(horizontal = 16.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Box(Modifier.width(128.dp).aspectRatio(16f / 9f).clip(RoundedCornerShape(10.dp)).background(Brush.linearGradient(listOf(Color(0xFF3A3550), Color(0xFF1F1A29))))) {
            val still = m.meta?.stillPath
            if (lib.details && still != null) Art(a.api, still, "w300", Modifier.fillMaxSize())
            else Text(m.episode?.let { "E${it.episode}" } ?: "", color = Muted, fontFamily = BarlowCondensed, fontWeight = FontWeight.Bold, fontSize = 18.sp, modifier = Modifier.align(Alignment.Center))
            if (m.duration != null) Text(episodeLength(m), fontSize = 11.sp, color = Color.White, modifier = Modifier.align(Alignment.BottomEnd).padding(5.dp).clip(RoundedCornerShape(4.dp)).background(Color(0xCC0A070E)).padding(horizontal = 6.dp))
        }
        // Adding to a party: the length and whether it's already lined up, with an Add button (✓ once added).
        val playing = a.adding && PartyLink.playing == m.id
        val queued = a.adding && PartyLink.queued(m.id)
        Column(Modifier.weight(1f)) {
            EpisodeTitle(m, special, 15)
            if (a.adding) {
                Row {
                    Text(episodeLength(m), color = Muted, fontSize = 12.sp)
                    val status = if (playing) "Playing now" else if (queued) "In Up next" else null
                    status?.let { Text((if (m.duration != null) " · " else "") + it, color = Accent, fontSize = 12.sp) }
                }
            } else {
                val sub = m.meta?.overview?.takeIf { m.episode != null } ?: listOfNotNull(m.extra?.kind, "Subtitles".takeIf { m.subtitles.isNotEmpty() }).joinToString(" · ")
                if (sub.isNotEmpty()) Text(sub, color = Muted, fontSize = 12.sp, lineHeight = 16.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
        }
        if (a.adding && !playing) {
            if (queued) {
                Box(Modifier.size(40.dp), contentAlignment = Alignment.Center) {
                    Icon(painterResource(R.drawable.ic_check), contentDescription = "In Up next", tint = Accent, modifier = Modifier.size(20.dp))
                }
            } else {
                Box(
                    Modifier.size(40.dp).clip(CircleShape).background(Tonal).clickable { a.queue(m.part?.ids ?: listOf(m.id), m.meta?.title ?: m.title) },
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(painterResource(R.drawable.ic_list_plus), contentDescription = "Add to Up next", tint = Color.White, modifier = Modifier.size(20.dp))
                }
            }
        }
        if (!playing) {
            Box(
                Modifier.size(40.dp).clip(CircleShape).background(Tonal).clickable { a.start(m, m.part?.ids) },
                contentAlignment = Alignment.Center,
            ) {
                Icon(painterResource(R.drawable.ic_play_filled), contentDescription = a.startLabel, tint = Color.White, modifier = Modifier.size(18.dp).offset(x = 1.dp))
            }
        }
    }
}

// ---------- Small parts ----------

/**
 * A rounded button: filled orange ([primary]), see-through white (tonal), or plain [text]. The one a TV remote is on
 * turns white with dark text and grows a little.
 */
@Composable
private fun Pill(
    label: String,
    icon: Int?,
    modifier: Modifier = Modifier,
    primary: Boolean = false,
    small: Boolean = false,
    text: Boolean = false,
    wide: Boolean = false,
    enabled: Boolean = true,
    onClick: () -> Unit,
) {
    val interaction = remember { MutableInteractionSource() }
    val focused by interaction.collectIsFocusedAsState()
    val bg = when {
        focused -> FocusFill
        primary -> Accent
        text -> Color.Transparent
        else -> Tonal
    }
    val fg = if (focused || primary) OnFocus else if (text) Muted else Color.White
    Row(
        modifier
            .then(if (wide) Modifier.fillMaxWidth() else Modifier)
            .scale(if (focused) 1.06f else 1f)
            .clip(CircleShape)
            .background(bg)
            .remembersFocus()
            .clickable(interactionSource = interaction, indication = androidx.compose.material3.ripple(), enabled = enabled, onClick = onClick)
            .heightIn(min = if (small) 38.dp else 46.dp)
            .padding(horizontal = if (small) 16.dp else 22.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterHorizontally),
    ) {
        icon?.let { Icon(painterResource(it), contentDescription = null, tint = fg, modifier = Modifier.size(if (small) 16.dp else 18.dp)) }
        Text(label, color = fg, fontSize = if (small) 14.sp else 15.sp, fontWeight = FontWeight.SemiBold, maxLines = 1)
    }
}

/** A round ⋮ button that opens a short menu of more actions; white while the remote is on it. */
@Composable
private fun MoreButton(actions: List<Pair<String, () -> Unit>>) {
    val interaction = remember { MutableInteractionSource() }
    val focused by interaction.collectIsFocusedAsState()
    var open by remember { mutableStateOf(false) }
    Box {
        Box(
            Modifier
                .scale(if (focused) 1.06f else 1f)
                .size(46.dp)
                .clip(CircleShape)
                .background(if (focused) FocusFill else Tonal)
                .remembersFocus()
                .clickable(interactionSource = interaction, indication = null) { open = true },
            contentAlignment = Alignment.Center,
        ) {
            Icon(painterResource(R.drawable.ic_more_vert), contentDescription = "More", tint = if (focused) OnFocus else Color.White, modifier = Modifier.size(20.dp))
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }, containerColor = Panel) {
            actions.forEach { (label, action) ->
                DropdownMenuItem(text = { Text(label) }, onClick = { open = false; action() })
            }
        }
    }
}

/**
 * Which party videos are being added to, and how many are lined up: on a TV a pill that goes back to the party, on a
 * phone a small label (the page's back arrow goes back).
 */
@Composable
private fun PartyPill(tv: Boolean, modifier: Modifier, onBack: () -> Unit) {
    val party = PartyLink.party ?: return
    val count = PartyLink.upcoming.size
    val interaction = remember { MutableInteractionSource() }
    val focused by interaction.collectIsFocusedAsState()
    if (tv) {
        Row(
            modifier
                .scale(if (focused) 1.05f else 1f)
                .clip(CircleShape)
                .background(if (focused) FocusFill else Color(0xE6100C15))
                .remembersFocus()
                .clickable(interactionSource = interaction, indication = null, onClick = onBack)
                .heightIn(min = 44.dp)
                .padding(horizontal = 18.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(painterResource(R.drawable.ic_back), contentDescription = null, tint = if (focused) OnFocus else Color.White, modifier = Modifier.size(18.dp))
            Text(if (PartyLink.solo) "Back to the player" else "Back to party ${party.code}", color = if (focused) OnFocus else Color.White, fontSize = 15.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(start = 12.dp))
            Text(" · $count in Up next", color = if (focused) OnFocusMuted else Muted, fontSize = 14.sp)
        }
    } else {
        Text(
            (if (PartyLink.solo) "Adding to Up next" else "Adding to party ${party.code}") + " · $count next",
            color = Color.White,
            fontSize = 12.sp,
            fontWeight = FontWeight.Medium,
            modifier = modifier.clip(CircleShape).background(Color(0xD9100C15)).padding(horizontal = 12.dp, vertical = 6.dp),
        )
    }
}

/** A Material 3 snackbar: what just happened, and Undo. */
@Composable
private fun Snackbar(text: String, modifier: Modifier, onUndo: () -> Unit) {
    Row(
        modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).background(Color(0xFFEEEAF3)).padding(start = 16.dp, end = 4.dp).heightIn(min = 48.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(text, color = OnFocus, fontSize = 14.sp, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
        Text("Undo", color = Color(0xFF8A4F1E), fontSize = 14.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.clip(RoundedCornerShape(8.dp)).clickable(onClick = onUndo).padding(12.dp))
    }
}

/** A filter or season chip: light when selected (as on the web app), white and larger when the remote is on it. */
@Composable
private fun Chip(label: String, selected: Boolean, tv: Boolean, onClick: () -> Unit) {
    val interaction = remember { MutableInteractionSource() }
    val focused by interaction.collectIsFocusedAsState()
    val shape = CircleShape
    Box(
        Modifier
            .scale(if (focused) 1.08f else 1f)
            .clip(shape)
            .background(if (focused) FocusFill else if (selected) Color(0xFFEEEAF3) else Color.Transparent)
            .border(1.dp, if (focused || selected) Color.Transparent else Muted.copy(alpha = 0.35f), shape)
            .remembersFocus()
            .clickable(interactionSource = interaction, indication = if (tv) null else androidx.compose.material3.ripple(), onClick = onClick)
            .heightIn(min = 34.dp)
            .padding(horizontal = 14.dp, vertical = 7.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(label, color = if (selected || focused) OnFocus else Muted, fontSize = 13.sp, fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Medium)
    }
}

@Composable
private fun Message(text: String, isError: Boolean) {
    Box(Modifier.fillMaxSize().padding(32.dp), contentAlignment = Alignment.Center) {
        Text(text, color = if (isError) ErrorColor else Muted)
    }
}

@Composable
private fun JoinCodeDialog(onDismiss: () -> Unit, onJoin: (String) -> Unit) {
    var code by remember { mutableStateOf("") }
    val field = remember { FocusRequester() }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Join a party") },
        text = {
            OutlinedTextField(
                value = code,
                onValueChange = { code = it },
                label = { Text("Party code or invite link") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Go),
                keyboardActions = KeyboardActions(onGo = { onJoin(code) }),
                modifier = Modifier.focusRequester(field),
            )
        },
        confirmButton = { DialogButton("Join") { onJoin(code) } },
        dismissButton = { DialogButton("Cancel", onClick = onDismiss) },
        containerColor = DialogSurface,
    )
    LaunchedEffect(Unit) { runCatching { field.requestFocus() } }
}

@Composable
private fun rememberImage(api: Api, path: String, size: String): ImageBitmap? =
    produceState<ImageBitmap?>(null, path, size) { value = api.image(path, size) }.value

/** A TMDB image loaded through the server, cropped to fill [modifier]; nothing while it loads or if there's none. */
@Composable
private fun Art(api: Api, path: String, size: String, modifier: Modifier) {
    val image = rememberImage(api, path, size)
    Box(modifier) { image?.let { Image(it, null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize()) } }
}
