package de.mornihosting.mornicraft;

import java.util.ArrayList;
import java.util.List;
import java.util.function.Consumer;
import org.bukkit.Bukkit;
import org.bukkit.entity.Player;
import org.geysermc.cumulus.form.ModalForm;
import org.geysermc.cumulus.form.SimpleForm;
import org.geysermc.floodgate.api.FloodgateApi;

/** Bedrock menus through Floodgate. Only created when the Floodgate plugin runs. */
final class FloodgateMenus {
  private final MorniCraft plugin;
  private final FloodgateApi api;

  FloodgateMenus(MorniCraft plugin) {
    this.plugin = plugin;
    this.api = FloodgateApi.getInstance();
    if (api == null) throw new IllegalStateException("Floodgate did not start");
  }

  boolean isBedrock(Player p) {
    return api.isFloodgatePlayer(p.getUniqueId());
  }

  private void onMain(Runnable r) {
    Bukkit.getScheduler().runTask(plugin, r);
  }

  /** A yes/no window. */
  void ask(Player p, String title, String content, String yes, String no, Consumer<Boolean> answer) {
    api.sendForm(p.getUniqueId(), ModalForm.builder()
        .title(title).content(content).button1(yes).button2(no)
        .validResultHandler(r -> onMain(() -> answer.accept(r.clickedFirst())))
        .build());
  }

  /** A menu: each button runs its action. */
  void menu(Player p, String title, String content, List<String> buttons, List<Runnable> actions) {
    SimpleForm.Builder b = SimpleForm.builder().title(title).content(content);
    buttons.forEach(b::button);
    List<Runnable> run = new ArrayList<>(actions);
    b.validResultHandler(r -> {
      int i = r.clickedButtonId();
      if (i >= 0 && i < run.size()) onMain(run.get(i));
    });
    api.sendForm(p.getUniqueId(), b.build());
  }
}
