import {registerMessages} from './i18n';
registerMessages({
 '历史版本保存目录不能是符号链接。':'The version history folder cannot be a symbolic link.',
 '历史版本设置文件不能是符号链接。':'The version history settings cannot be a symbolic link.',
 '无法读取历史版本设置；数据库尚未保存。请在历史版本中重新设置。':'Version settings could not be read. The database has not been saved. Set the preferences again in version history.',
 '请选择是否保留历史版本，并输入 1 至 100 之间的保留份数。':'Choose whether to retain versions and enter a retention count from 1 to 100.',
 '该历史版本不存在，请刷新列表。':'This version is no longer available. Refresh the list.',
 '历史版本文件已改变，未执行操作。':'The saved version has changed. No action was taken.',
 '原数据库已被修改或删除，请重新打开或另存为新文件。':'The original database was changed or removed. Reopen it or save to a new file.',
 '请选择历史版本目录之外的位置保存副本。':'Save the restored copy outside the version history folder.',
 '无法识别历史版本操作。':'This version history action is not available.',
 '系统数据库没有个人历史版本。':'System databases do not have personal version history.',
 '无法保存历史版本，原数据库尚未改动。请检查保存位置的权限或可用空间，然后重试。':'The previous version could not be saved. The original database is unchanged. Check permissions and available space, then try again.',
 '数据库及本次历史版本已保存，但未能清理较早版本。请在历史版本中检查。':'The database and its previous version were saved, but older versions could not be removed. Check version history.',
});
